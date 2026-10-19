"""Video router — FastAPI endpoints for the narrated slide-video generator.

Mounted under /api/video by app.py. PoC-only: jobs and scripts live
in process memory. Long-running renders are dispatched as BackgroundTasks.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    HTTPException,
    UploadFile,
)
from fastapi.responses import FileResponse, Response, StreamingResponse

from auth import Principal, get_principal, require_admin
from config import AzureConfig, load_config
from security import (
    DAILY_QUOTA,
    MAX_NARRATION_CHARS,
    MAX_SLIDES_PER_RENDER,
    PENDING_RENDERS,
    VIDEO_JOB_RE,
    UUID_RE,
    acquire_render_slot,
    is_valid,
    read_upload_limited,
    require_id,
    safe_filename,
)
from services.demo_protocol import (
    CAPTIONS_VTT_CACHE_CONTROL,
    CAPTIONS_VTT_MEDIA_TYPE,
    LIBRARY_UNAVAILABLE_DETAIL,
)
from services.scorm_packager import build_scorm_package
from services.voice_catalog import HD_VOICES, is_allowed_voice
from services.video_models import (
    IngestResponse,
    JobOutputs,
    JobProgress,
    JobState,
    LanguageOption,
    LibraryItem,
    LibrarySummary,
    NarrationPatch,
    PublishRequest,
    ScriptPatch,
    ScriptRequest,
    SlideNarration,
    VideoDocument,
    VideoJob,
    VideoScript,
    VoiceOption,
)
from services.podcast_models import (
    LibraryUnavailable,
    audience_level_or_none,
    source_deck_id_or_none,
    srt_to_vtt,
)

log = logging.getLogger(__name__)
# Failed library reads (and captions of an unpublished item) must never be cached.
NO_STORE = "no-store"
# Everything on `router` is admin-only (default deny). Anonymous library
# reads (published items only) live on `public_router`.
router = APIRouter(prefix="/api/video", tags=["video"], dependencies=[Depends(require_admin)])
public_router = APIRouter(prefix="/api/video", tags=["video-public"])

# ---------------------------------------------------------------------------
# In-memory stores (PoC)
# ---------------------------------------------------------------------------
DOCUMENTS: dict[str, VideoDocument] = {}
SCRIPTS: dict[str, VideoScript] = {}
JOBS: dict[str, VideoJob] = {}
_JOB_FILES: dict[str, dict[str, Path]] = {}

_LIBRARY = None


def _get_library(cfg: AzureConfig):
    global _LIBRARY
    if _LIBRARY is None:
        from services.video_library import VideoLibrary
        _LIBRARY = VideoLibrary(cfg)
    return _LIBRARY


# ---------------------------------------------------------------------------
# Catalog — 8 DragonHD languages (same set as the podcast)
# ---------------------------------------------------------------------------
LANGUAGES: list[LanguageOption] = [
    LanguageOption(code="en-US", name="English (US)"),
    LanguageOption(code="fr-FR", name="French"),
    LanguageOption(code="es-ES", name="Spanish"),
    LanguageOption(code="de-DE", name="German"),
    LanguageOption(code="it-IT", name="Italian"),
    LanguageOption(code="pt-BR", name="Portuguese (Brazil)"),
    LanguageOption(code="zh-CN", name="Chinese (Simplified)"),
    LanguageOption(code="ja-JP", name="Japanese"),
]

VOICES: list[VoiceOption] = [
    VoiceOption(id=vid, display_name=name, language=lang, gender=gender)
    for vid, name, lang, gender in HD_VOICES
]


def get_cfg() -> AzureConfig:
    return load_config()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Catalog endpoints
# ---------------------------------------------------------------------------
@router.get("/languages", response_model=list[LanguageOption])
def list_languages() -> list[LanguageOption]:
    return LANGUAGES


@router.get("/voices", response_model=list[VoiceOption])
def list_voices(language: Optional[str] = None) -> list[VoiceOption]:
    if language:
        return [v for v in VOICES if v.language == language]
    return VOICES


# ---------------------------------------------------------------------------
# Ingest
# ---------------------------------------------------------------------------
_ALLOWED_SUFFIXES = {".pptx", ".pdf", ".png", ".jpg", ".jpeg", ".webp"}


@router.post("/ingest", response_model=IngestResponse)
async def ingest_document(
    file: UploadFile = File(...),
    cfg: AzureConfig = Depends(get_cfg),
    principal: Principal = Depends(require_admin),
) -> IngestResponse:
    """Ingest a PPTX / PDF / single image into a normalized slide list."""
    from services.video_ingest import ingest as do_ingest

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in _ALLOWED_SUFFIXES:
        raise HTTPException(
            400,
            f"Unsupported file type '{suffix}'. Video accepts: .pptx, .pdf, .png, .jpg, .jpeg",
        )

    content = await read_upload_limited(file)
    DAILY_QUOTA.consume(principal.user_id)

    tmp_dir = Path("data/uploads/video")
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = tmp_dir / f"{uuid.uuid4().hex}{suffix}"
    tmp_path.write_bytes(content)

    try:
        doc = await asyncio.to_thread(do_ingest, str(tmp_path), safe_filename(file.filename, "upload"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception:  # noqa: BLE001
        log.exception("video ingest failed")
        raise HTTPException(500, "Ingestion failed")

    DOCUMENTS[doc.doc_id] = doc
    # image_ref is a server-local path (used by the renderer); the browser gets a URL.
    return IngestResponse(
        doc_id=doc.doc_id,
        title=doc.title,
        source_kind=doc.source_kind,
        slides=[
            s.model_copy(update={"image_ref": _slide_image_url(doc.doc_id, s.index) if s.image_ref else ""})
            for s in doc.slides
        ],
    )


_UPLOAD_ROOT = Path("data/uploads/video")
_IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}


def _slide_image_url(doc_id: str, index: int) -> str:
    return f"/api/video/documents/{doc_id}/slides/{index}/image"


@router.get("/documents/{doc_id}/slides/{index}/image")
def get_slide_image(doc_id: str, index: int) -> FileResponse:
    """Slide preview image of an ingested document (wizard thumbnails)."""
    require_id(doc_id, UUID_RE, "Document")
    doc = DOCUMENTS.get(doc_id)
    ref = next((s for s in doc.slides if s.index == index), None) if doc else None
    if not ref or not ref.image_ref:
        raise HTTPException(404, "Slide image not found")
    path = Path(ref.image_ref).resolve()
    media_type = _IMAGE_TYPES.get(path.suffix.lower())
    if not media_type or _UPLOAD_ROOT.resolve() not in path.parents or not path.is_file():
        raise HTTPException(404, "Slide image not found")
    return FileResponse(path, media_type=media_type)


# ---------------------------------------------------------------------------
# Script — streaming generate, get, patch
# ---------------------------------------------------------------------------
@router.post("/script/{doc_id}")
async def generate_script(
    doc_id: str,
    req: ScriptRequest,
    cfg: AzureConfig = Depends(get_cfg),
    principal: Principal = Depends(require_admin),
):
    """Stream NDJSON: one SlideNarration per line + a final `done` event."""
    from services.video_script import generate_script_stream

    require_id(doc_id, UUID_RE, "Document")
    doc = DOCUMENTS.get(doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    if not is_allowed_voice(req.voice):
        raise HTTPException(400, "Unsupported voice")
    DAILY_QUOTA.consume(principal.user_id)

    async def gen():
        narrations: list[SlideNarration] = []
        try:
            async for narration in generate_script_stream(cfg, doc, req):
                narrations.append(narration)
                yield json.dumps({"event": "narration", "data": narration.model_dump()}) + "\n"
            script = VideoScript(
                doc_id=doc.doc_id,
                language=req.language,
                style=req.style,
                focus=req.focus,
                audience_level=req.audience_level,
                voice=req.voice,
                narrations=sorted(narrations, key=lambda n: n.slide_index),
            )
            SCRIPTS[doc.doc_id] = script
            yield json.dumps({"event": "done", "data": script.model_dump()}) + "\n"
        except Exception:  # noqa: BLE001
            log.exception("video script stream failed")
            yield json.dumps({"event": "error", "data": {"message": "Script generation failed"}}) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson")


@router.get("/script/{doc_id}", response_model=VideoScript)
def get_script(doc_id: str) -> VideoScript:
    require_id(doc_id, UUID_RE, "Script")
    script = SCRIPTS.get(doc_id)
    if not script:
        raise HTTPException(404, "Script not found")
    return script


@router.patch("/script/{doc_id}", response_model=VideoScript)
def patch_script(doc_id: str, patch: ScriptPatch) -> VideoScript:
    require_id(doc_id, UUID_RE, "Script")
    script = SCRIPTS.get(doc_id)
    if not script:
        raise HTTPException(404, "Script not found")
    for p in patch.patches:
        if p.voice is not None and not is_allowed_voice(p.voice):
            raise HTTPException(400, "Unsupported voice")

    by_idx: dict[int, SlideNarration] = {n.slide_index: n for n in script.narrations}
    for p in patch.patches:
        existing = by_idx.get(p.slide_index)
        if existing is None:
            continue  # silently skip unknown slide indices
        if p.narration is not None:
            existing.narration = p.narration
        if p.speaking_style is not None:
            existing.speaking_style = p.speaking_style
        if p.voice is not None:
            existing.voice = p.voice
    script.narrations = sorted(by_idx.values(), key=lambda n: n.slide_index)
    SCRIPTS[doc_id] = script
    return script


# ---------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------
@router.post("/render/{doc_id}")
async def start_render(
    doc_id: str,
    bg: BackgroundTasks,
    cfg: AzureConfig = Depends(get_cfg),
    principal: Principal = Depends(require_admin),
) -> dict:
    require_id(doc_id, UUID_RE, "Document")
    script = SCRIPTS.get(doc_id)
    if not script:
        raise HTTPException(404, "No script for this document; generate one first")
    doc = DOCUMENTS.get(doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    if len(script.narrations) > MAX_SLIDES_PER_RENDER:
        raise HTTPException(400, f"Too many slides (max {MAX_SLIDES_PER_RENDER})")
    for n in script.narrations:
        if len(n.narration or "") > MAX_NARRATION_CHARS:
            raise HTTPException(400, f"Narration too long (max {MAX_NARRATION_CHARS} characters)")
        if n.voice and not is_allowed_voice(n.voice):
            raise HTTPException(400, "Unsupported voice")
    if not is_allowed_voice(script.voice):
        raise HTTPException(400, "Unsupported voice")
    acquire_render_slot()
    try:
        DAILY_QUOTA.consume(principal.user_id)
    except HTTPException:
        PENDING_RENDERS.release()
        raise

    job_id = f"sv-{uuid.uuid4().hex[:8]}"
    job = VideoJob(
        job_id=job_id,
        doc_id=doc_id,
        state=JobState.queued,
        progress=JobProgress(stage="queued", total=len(script.narrations)),
        outputs=JobOutputs(),
        created_at=_now(),
        updated_at=_now(),
    )
    JOBS[job_id] = job
    bg.add_task(_run_render_job, job_id, cfg)
    return {"job_id": job_id}


@router.get("/jobs/{job_id}", response_model=VideoJob)
def get_job(job_id: str) -> VideoJob:
    require_id(job_id, VIDEO_JOB_RE, "Job")
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    return job


@router.get("/jobs/{job_id}/file/{kind}")
def download_job_file(job_id: str, kind: str):
    """Serve the rendered mp4/mp3/srt/thumb/scorm from local disk (pre-publish)."""
    require_id(job_id, VIDEO_JOB_RE, "Job")
    if kind not in {"mp4", "mp3", "srt", "thumb", "scorm"}:
        raise HTTPException(404, "File not found")
    files = _JOB_FILES.get(job_id)

    # Lazy-generate SCORM package on first request
    if kind == "scorm" and files:
        scorm_path = files.get("scorm")
        if not scorm_path or not scorm_path.exists():
            mp4_path = files.get("mp4")
            srt_path = files.get("srt")
            if not mp4_path or not mp4_path.exists() or not srt_path or not srt_path.exists():
                raise HTTPException(404, "MP4/SRT not available for SCORM packaging")
            job = JOBS.get(job_id)
            if not job:
                raise HTTPException(404, f"Job {job_id} not found")
            doc = DOCUMENTS.get(job.doc_id)
            script = SCRIPTS.get(job.doc_id)
            title = (doc.title if doc else job.doc_id) or job.doc_id
            language = script.language if script else "en-US"
            scorm_path = build_scorm_package(
                title=title,
                language=language,
                media_path=mp4_path,
                srt_path=srt_path,
                out_dir=mp4_path.parent,
                thumbnail_path=files.get("thumb"),
            )
            files["scorm"] = scorm_path

    if not files or kind not in files:
        raise HTTPException(404, "File not found")
    p = files[kind]
    if not p or not p.exists():
        raise HTTPException(404, "File not found on disk")
    media = {
        "mp4": "video/mp4",
        "mp3": "audio/mpeg",
        "srt": "application/x-subrip",
        "thumb": "image/jpeg",
        "scorm": "application/zip",
    }.get(kind, "application/octet-stream")
    dl_name = p.name
    if kind == "scorm":
        _job = JOBS.get(job_id)
        _doc = DOCUMENTS.get(_job.doc_id) if _job else None
        label = (_doc.title if _doc and _doc.title else job_id)
        dl_name = f"{label}-scorm.zip"
    return FileResponse(p, media_type=media, filename=dl_name)


# ---------------------------------------------------------------------------
# Library
# ---------------------------------------------------------------------------
def _library_unavailable(cause: Exception | None = None) -> HTTPException:
    """503 of a library read whose storage is failing: never an empty list and never a 404 (contracts §2.4)."""
    if cause is not None:
        log.warning("Video library unavailable: %s", cause)
    return HTTPException(status_code=503, detail=LIBRARY_UNAVAILABLE_DETAIL, headers={"Cache-Control": NO_STORE})


def _captions_url(job_id: object) -> Optional[str]:
    """Same-origin URL of an item's WebVTT captions (None unless ``job_id`` is a library video id)."""
    return f"/api/video/library/{job_id}/captions.vtt" if is_valid(job_id, VIDEO_JOB_RE) else None


def _public_item(item: dict) -> dict:
    """Anonymous DTO: no audio/subtitles/SCORM/script, video + thumbnail only.

    Carries the audience level, the source deck (``source_deck_id``, null
    unless the manifest links one) and, when the item has a subtitle blob, the
    same-origin ``captions_vtt_url`` (WebVTT served by ``captions.vtt``); the
    SAS-signed ``srt_url`` stays None."""
    return {
        "job_id": item.get("job_id"),
        "title": item.get("title") or "",
        "created_at": item.get("created_at") or "",
        "duration_sec": item.get("duration_sec"),
        "language": item.get("language") or "en-US",
        "audience_level": audience_level_or_none(item.get("audience_level")),
        "source_deck_id": source_deck_id_or_none(item.get("source_deck_id")),
        "captions_vtt_url": _captions_url(item.get("job_id")) if item.get("has_captions") is True else None,
        "thumbnail_url": item.get("thumbnail_url"),
        "video_url": item.get("video_url"),
        "audio_url": None,
        "srt_url": None,
        "scorm_url": None,
        "script": None,
    }


def _full_item(item: dict) -> dict:
    return LibraryItem(**{
        "job_id": item["job_id"],
        "title": item.get("title") or "",
        "document_title": item.get("document_title") or "",
        "created_at": item.get("created_at") or "",
        "duration_sec": item.get("duration_sec"),
        "language": item.get("language") or "en-US",
        "voice": item.get("voice") or "",
        "audience_level": audience_level_or_none(item.get("audience_level")),
        "slide_count": item.get("slide_count") or 0,
        "thumbnail_url": item.get("thumbnail_url"),
        "published": bool(item.get("published")),
        "video_url": item.get("video_url"),
        "audio_url": item.get("audio_url"),
        "srt_url": item.get("srt_url"),
        "scorm_url": item.get("scorm_url"),
    }).model_dump()


@public_router.get("/library")
def list_library(
    cfg: AzureConfig = Depends(get_cfg),
    principal: Principal = Depends(get_principal),
) -> list[dict]:
    """Admins: every archived video (+ `published`); anonymous: published only.

    ``[]`` means nothing is published (or storage is not configured at all). A
    storage that is configured but failing answers 503 — never an empty list.
    """
    lib = _get_library(cfg)
    if not lib.available:
        if lib.configured:
            raise _library_unavailable()
        return []
    try:
        if principal.is_admin:
            return [LibrarySummary(**{**item, "title": item.get("title") or "",
                                      "document_title": item.get("document_title") or "",
                                      "created_at": item.get("created_at") or "",
                                      "language": item.get("language") or "en-US",
                                      "audience_level": audience_level_or_none(item.get("audience_level"))
                                      }).model_dump()
                    for item in lib.list(strict=True)]
        return [_public_item(item) for item in lib.list(published_only=True, strict=True)]
    except LibraryUnavailable as exc:
        raise _library_unavailable(exc) from exc


@public_router.get("/library/{job_id}")
def get_library_item(
    job_id: str,
    cfg: AzureConfig = Depends(get_cfg),
    principal: Principal = Depends(get_principal),
) -> dict:
    """404 means the item does not exist (or is not published); a storage failure answers 503, never 404."""
    require_id(job_id, VIDEO_JOB_RE, "Library item")
    lib = _get_library(cfg)
    if not lib.available:
        raise _library_unavailable()
    try:
        item = lib.get(job_id, strict=True) if principal.is_admin else lib.get(job_id, public=True, strict=True)
    except LibraryUnavailable as exc:
        raise _library_unavailable(exc) from exc
    if not item:
        raise HTTPException(404, "Library item not found")
    return _full_item(item) if principal.is_admin else _public_item(item)


@public_router.get("/library/{job_id}/captions.vtt", response_class=Response)
def get_library_captions(
    job_id: str,
    cfg: AzureConfig = Depends(get_cfg),
    principal: Principal = Depends(get_principal),
) -> Response:
    """WebVTT captions of a library video, for the player's ``<track>``.

    Same visibility as the item route: anonymous callers get published
    items only (404 otherwise), admins any item. The SRT timed on the video
    is converted server-side. Published items are cacheable for 10 minutes;
    an unpublished item read by an admin is not.
    """
    require_id(job_id, VIDEO_JOB_RE, "Library item")
    lib = _get_library(cfg)
    if not lib.available:
        raise _library_unavailable()
    try:
        source = lib.captions_source(job_id, public=not principal.is_admin)
    except LibraryUnavailable as exc:
        raise _library_unavailable(exc) from exc
    if source is None:
        raise HTTPException(404, "Library item not found", headers={"Cache-Control": NO_STORE})
    vtt = srt_to_vtt(source.text) if source.text else None
    if vtt is None:
        raise HTTPException(404, "Captions not available", headers={"Cache-Control": NO_STORE})
    return Response(
        vtt,
        media_type=CAPTIONS_VTT_MEDIA_TYPE,
        headers={"Cache-Control": CAPTIONS_VTT_CACHE_CONTROL if source.published else NO_STORE},
    )


@router.post("/library/{job_id}/publish")
def publish_library_item(job_id: str, body: PublishRequest, cfg: AzureConfig = Depends(get_cfg)) -> dict:
    """Admin: show/hide a library item to anonymous viewers."""
    require_id(job_id, VIDEO_JOB_RE, "Library item")
    lib = _get_library(cfg)
    if not lib.available:
        raise HTTPException(503, "Library storage not available")
    item = lib.set_published(job_id, body.published)
    if not item:
        raise HTTPException(404, "Library item not found")
    return _full_item(item)


@router.delete("/library/{job_id}")
def delete_library_item(job_id: str, cfg: AzureConfig = Depends(get_cfg)) -> dict:
    require_id(job_id, VIDEO_JOB_RE, "Library item")
    lib = _get_library(cfg)
    if not lib.available:
        raise HTTPException(503, "Library storage not available")
    ok = lib.delete(job_id)
    if not ok:
        raise HTTPException(404, "Not found or delete failed")
    return {"deleted": job_id}


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------
async def _run_render_job(job_id: str, cfg: AzureConfig) -> None:
    try:
        await _render_job_body(job_id, cfg)
    finally:
        PENDING_RENDERS.release()


async def _render_job_body(job_id: str, cfg: AzureConfig) -> None:
    from services.video_render import render_video
    from services.video_compose import compose_video
    from services.video_library import VideoLibraryFiles

    job = JOBS[job_id]
    script = SCRIPTS[job.doc_id]
    doc = DOCUMENTS.get(job.doc_id)

    def _update(state: JobState, stage: str, *, completed: int = 0, total: int | None = None,
                percent: int | None = None, message: str = "", error: Optional[str] = None) -> None:
        job.state = state
        job.progress.stage = stage
        job.progress.completed = completed
        job.progress.total = total if total is not None else len(script.narrations)
        if percent is not None:
            job.progress.percent = max(0, min(100, percent))
        job.progress.message = message
        job.error = error
        job.updated_at = _now()

    try:
        total = len(script.narrations)
        _update(JobState.rendering, "rendering", total=total, percent=5,
                message="Submitting batch avatar jobs…")

        def _progress(done: int, tot: int) -> None:
            # Render dominates 5..75%
            pct = 5 + int((done / max(1, tot)) * 70)
            _update(JobState.rendering, "rendering", completed=done, total=tot,
                    percent=pct, message=f"Synthesized {done}/{tot} slides")

        clips = await asyncio.to_thread(render_video, cfg, script, _progress)

        _update(JobState.composing, "composing", completed=len(clips), percent=78,
                message="Compositing slides + avatar PiP…")
        out_dir = Path("data/video/out") / job.job_id
        result = await asyncio.to_thread(compose_video, clips, doc, script, out_dir)

        # Local download URLs (pre-publish fallback)
        job.outputs = JobOutputs(
            video_url=f"/api/video/jobs/{job.job_id}/file/mp4",
            audio_url=f"/api/video/jobs/{job.job_id}/file/mp3",
            srt_url=f"/api/video/jobs/{job.job_id}/file/srt",
            thumbnail_url=f"/api/video/jobs/{job.job_id}/file/thumb" if result.thumbnail else None,
            duration_sec=result.duration_sec,
        )
        _JOB_FILES[job.job_id] = {
            "mp4": result.mp4,
            "mp3": result.mp3,
            "srt": result.srt,
            **({"thumb": result.thumbnail} if result.thumbnail else {}),
        }
        _update(JobState.publishing, "publishing", completed=len(clips), percent=92,
                message="Uploading to library…")

        # Publish to blob — failure doesn't fail the job, just flags archive.
        job.archive_state = "archiving"
        try:
            lib = _get_library(cfg)
            if lib.available:
                title = (doc.title if doc else script.doc_id) or script.doc_id
                scorm_path = await asyncio.to_thread(
                    build_scorm_package,
                    title=title,
                    language=script.language,
                    media_path=result.mp4,
                    srt_path=result.srt,
                    out_dir=out_dir,
                    thumbnail_path=result.thumbnail,
                )
                _JOB_FILES[job.job_id]["scorm"] = scorm_path
                manifest = await asyncio.to_thread(
                    lib.publish,
                    job.job_id,
                    VideoLibraryFiles(
                        mp4=result.mp4, mp3=result.mp3, srt=result.srt,
                        thumb=result.thumbnail, scorm=scorm_path,
                    ),
                    title=title,
                    document_title=(doc.title if doc else ""),
                    language=script.language,
                    voice=script.voice,
                    slide_count=len(script.narrations),
                    duration_sec=result.duration_sec,
                    created_at=job.created_at,
                    audience_level=script.audience_level,
                )
                job.archive_state = "published" if manifest else "failed"
            else:
                job.archive_state = "failed"
        except Exception:  # noqa: BLE001
            log.exception("Video library archive failed for %s", job_id)
            job.archive_state = "failed"

        _update(JobState.done, "done", completed=len(clips), percent=100, message="Ready")
    except Exception:  # noqa: BLE001
        log.exception("video render job %s failed", job_id)
        _update(JobState.failed, "failed", error="Render failed; see server logs")
