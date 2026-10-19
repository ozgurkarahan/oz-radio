"""Oz Radio — FastAPI Backend Application."""

from __future__ import annotations

import asyncio
import copy
import threading
import time
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Callable, NamedTuple, Optional

from starlette.datastructures import Headers, MutableHeaders
from starlette.middleware.gzip import GZipMiddleware

# Configure logging before importing first-party modules: some of them log at
# import time (e.g. the avatar registry summary), which would otherwise be lost.
logging.basicConfig(level=logging.INFO)

from fastapi import APIRouter, Depends, FastAPI, File, UploadFile, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.requests import Request

import auth
from auth import Principal, get_principal, require_admin
from config import load_config, AzureConfig, telemetry_boot
from security import (
    DAILY_QUOTA,
    MAX_CHAT_MESSAGE_CHARS,
    MAX_CHAT_MESSAGES,
    MAX_TEXT_CHARS,
    MEDIA_TYPES,
    SLIDE_FILE_RE,
    UUID_RE,
    AVATAR_FILE_RE,
    DEMO_QUOTA,
    DEMO_SESSIONS,
    VOICE_SESSIONS,
    allowed_origins,
    client_ip,
    consume_quota,
    demo_max_speaks,
    demo_qa_enabled,
    demo_qa_max_questions,
    demo_quota_exempt,
    effective_demo_session_seconds,
    is_valid,
    max_voice_session_seconds,
    origin_allowed,
    public_demo_enabled,
    read_upload_limited,
    require_id,
    safe_filename,
    safe_join,
)
from services import avatar_registry
from services import demo_protocol as dp
from services.pptx_parser import parse_pptx, PresentationData
from services.translation import get_openai_client, translate_text, detect_language
from services.avatar import submit_batch_synthesis, get_batch_synthesis_status
from services.voice_proxy import demo_narration_chars, handle_demo_proxy, handle_voice_proxy
from services.voice_questions import ADMIN_MAX_QUESTIONS, MAX_AUDIO_SECONDS, QaOptions
from services.qa import index_presentation, answer_question
from services.storage import PresentationStore, StorageUnavailable, deck_title

# All supported target languages (en-US is the source, no translation needed)
SUPPORTED_LANGUAGES = [
    "fr-FR", "es-ES", "de-DE", "ja-JP", "zh-CN",
    "it-IT", "pt-BR", "ko-KR", "ar-SA",
]

logger = logging.getLogger(__name__)

# Directory to store rendered slide images
SLIDES_DIR = Path(__file__).resolve().parent / "data" / "slides"

# In-memory store for presentations (sufficient for PoC)
presentations: dict[str, PresentationData] = {}
config: Optional[AzureConfig] = None
store: Optional[PresentationStore] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global config, store
    config = load_config()
    store = PresentationStore(config)
    DEMO_QUOTA.set_store(store)  # durable demo budget (survives restarts / scale-to-zero)
    _boot_cache.warm()  # first-paint data for index.html, read in the background: never delays readiness
    auth.log_startup_warnings()
    logger.info("Oz Radio backend started. Region: %s", config.speech_region)
    if store.available:
        logger.info("Persistence enabled (Cosmos DB + Blob Storage)")
    elif store.cosmos_available:
        logger.info("Persistence partially enabled (Cosmos DB only — Blob Storage unavailable)")
    else:
        logger.info("Persistence disabled — using in-memory store only")
    yield


# Interactive API docs are only exposed in local development (AUTH_MODE=disabled).
_docs_enabled = auth.auth_mode() == "disabled"

app = FastAPI(
    title="Oz Radio",
    description="AI-powered avatar presentation assistant with multilingual TTS",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs" if _docs_enabled else None,
    redoc_url="/redoc" if _docs_enabled else None,
    openapi_url="/openapi.json" if _docs_enabled else None,
)

# /api/me (anonymous)
app.include_router(auth.router)

# Podcast — dual-avatar router (admin) + published-library reads (anonymous)
from routers.podcast import public_router as podcast_public_router, router as podcast_router
app.include_router(podcast_public_router)
app.include_router(podcast_router)

# Video — narrated slide video (single narrator, slide-first)
from routers.video import public_router as video_public_router, router as video_router
app.include_router(video_public_router)
app.include_router(video_router)

# Decks catalog — multi-deck upload, search + present
from routers.decks import public_router as decks_public_router, router as decks_router
app.include_router(decks_public_router)
app.include_router(decks_router)

from routers.playlists import router as playlists_router
app.include_router(playlists_router)

# CORS: only for explicitly configured origins (empty => same-origin only).
_cors_origins = allowed_origins()
if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type"],
    )


DEFAULT_FRAME_ANCESTORS = (
    "'self' https://teams.microsoft.com https://*.teams.microsoft.com "
    "https://*.office.com https://*.cloud.microsoft"
)


class SecurityHeadersMiddleware:
    """Pure-ASGI middleware adding security headers to every HTTP response.

    - CSP ``frame-ancestors`` from ``FRAME_ANCESTORS`` (Teams embedding)
    - ``X-Content-Type-Options: nosniff``
    - ``Referrer-Policy: strict-origin-when-cross-origin``
    """

    def __init__(self, app, frame_ancestors: Optional[str] = None) -> None:
        self.app = app
        fa = (frame_ancestors if frame_ancestors is not None
              else os.environ.get("FRAME_ANCESTORS", "")).strip() or DEFAULT_FRAME_ANCESTORS
        fa = fa.replace(";", " ").replace("\r", " ").replace("\n", " ")
        self._headers = [
            (b"content-security-policy", f"frame-ancestors {fa}".encode("latin-1", "ignore")),
            (b"x-content-type-options", b"nosniff"),
            (b"referrer-policy", b"strict-origin-when-cross-origin"),
        ]
        self._names = {h[0] for h in self._headers} | {b"x-frame-options"}

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = [
                    (k, v) for k, v in message.get("headers", [])
                    if k.lower() not in self._names
                ]
                headers.extend(self._headers)
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_wrapper)


app.add_middleware(SecurityHeadersMiddleware)

# Every legacy (non-router) endpoint below is admin-only unless it is
# explicitly registered on `app` as anonymous (health, avatars, slide
# images of published decks, Teams config page, SPA).
admin_router = APIRouter(dependencies=[Depends(require_admin)])


# --- Request/Response Models ---


class TranslateRequest(BaseModel):
    text: str = Field(..., max_length=MAX_TEXT_CHARS)
    target_language: str = Field(..., max_length=16)  # e.g., "fr-FR", "es-ES"


class TranslateResponse(BaseModel):
    translated_text: str
    source_language: str


class BatchAvatarRequest(BaseModel):
    presentation_id: str = Field(..., max_length=64)
    target_language: str = Field("en-US", max_length=16)
    # Registry id (stock or CUSTOM_AVATARS_JSON); defaults to the registry default.
    avatar: str = Field(default_factory=lambda: avatar_registry.DEFAULT_ID, max_length=64)


class BatchAvatarResponse(BaseModel):
    job_id: str
    status: str


class QaRequest(BaseModel):
    presentation_id: str = Field(..., max_length=64)
    question: str = Field(..., max_length=1000)
    slide_index: Optional[int] = Field(None, ge=0, le=10000)


class QaResponse(BaseModel):
    answer: str
    source_slides: list[int]


class SlideResponse(BaseModel):
    index: int
    title: str
    body: str
    notes: str
    image_url: Optional[str] = None
    video_url: Optional[str] = None
    translated_notes: dict[str, str] = {}


class PresentationResponse(BaseModel):
    id: str
    filename: str
    slide_count: int
    pptx_url: Optional[str] = None
    slides: list[SlideResponse]


class PresentationListItem(BaseModel):
    id: str
    filename: str
    slide_count: int


class TranslateNotesRequest(BaseModel):
    target_language: str = Field(..., max_length=16)  # e.g., "fr-FR"


class TranslatedSlide(BaseModel):
    index: int
    translated_notes: str


class TranslateNotesResponse(BaseModel):
    presentation_id: str
    target_language: str
    translated_slides: list[TranslatedSlide]
    cached: bool


# --- Health Check ---


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "oz-radio"}


@app.get("/api/avatars")
async def list_avatars():
    """Public avatar catalog (never includes the Speech character name)."""
    return avatar_registry.public_catalog()


AVATAR_THUMBS_DIR = Path(__file__).resolve().parent / "static" / "avatars"


@app.get("/static/avatars/{name}")
async def avatar_thumbnail(name: str):
    """Serve avatar thumbnails referenced by ``thumbnail_url``."""
    if not is_valid(name, AVATAR_FILE_RE):
        raise HTTPException(status_code=404, detail="Not found")
    path = safe_join(AVATAR_THUMBS_DIR, name)
    if not path or not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    # Revalidate (cheap 304 via ETag) so replaced thumbnails show up immediately.
    return FileResponse(path, media_type=MEDIA_TYPES[path.suffix.lower()], headers={"Cache-Control": "no-cache"})


# --- Upload & Parse ---


@admin_router.post("/api/upload", response_model=PresentationResponse)
async def upload_presentation(file: UploadFile = File(...), principal: Principal = Depends(require_admin)):
    """Upload and parse a PowerPoint file."""
    if not file.filename or not file.filename.lower().endswith(".pptx"):
        raise HTTPException(status_code=400, detail="Only .pptx files are supported")

    content = await read_upload_limited(file)

    # Validate file content is a real PPTX (ZIP with [Content_Types].xml)
    import zipfile, io as _io
    if not content[:4] == b"PK\x03\x04":
        raise HTTPException(
            status_code=400,
            detail="Invalid file: not a valid .pptx file. Please upload a PowerPoint (.pptx) file, not .ppt or other formats.",
        )
    try:
        with zipfile.ZipFile(_io.BytesIO(content)) as zf:
            if "[Content_Types].xml" not in zf.namelist():
                raise HTTPException(
                    status_code=400,
                    detail="Invalid file: ZIP archive does not contain PowerPoint data. Please upload a .pptx file.",
                )
    except zipfile.BadZipFile:
        raise HTTPException(
            status_code=400,
            detail="Invalid file: corrupted or incomplete .pptx file. Please re-export from PowerPoint and try again.",
        )

    DAILY_QUOTA.consume(principal.user_id)
    try:
        presentation = parse_pptx(
            content, safe_filename(file.filename, "presentation.pptx"), config.libreoffice_path if config else "soffice",
        )
    except Exception as e:
        logger.error("Failed to parse PPTX: %s", e)
        raise HTTPException(status_code=400, detail="Failed to parse file")

    # Save rendered slide images to disk and set image_url on each slide
    if presentation.slide_images:
        slides_dir = SLIDES_DIR / presentation.id
        slides_dir.mkdir(parents=True, exist_ok=True)
        for idx, png_bytes in presentation.slide_images:
            (slides_dir / f"{idx}.png").write_bytes(png_bytes)
            # Upload to Blob Storage if available
            if store and store.available:
                store.upload_slide_image(presentation.id, idx, png_bytes)
        for slide in presentation.slides:
            # Use Blob Storage URL when available, fallback to local API
            if store and store.available:
                blob_url = store.get_slide_image_url(presentation.id, slide.index)
                slide.image_url = blob_url or f"/api/slides/{presentation.id}/{slide.index}.png"
            else:
                slide.image_url = f"/api/slides/{presentation.id}/{slide.index}.png"
        presentation.slide_images = []  # free memory
        logger.info("Saved %d slide images for %s", presentation.slide_count, presentation.id)

    # Save extracted embedded videos to disk and set video_url on slides
    if presentation.slide_videos:
        slides_dir = SLIDES_DIR / presentation.id
        slides_dir.mkdir(parents=True, exist_ok=True)
        slide_map = {s.index: s for s in presentation.slides}
        for idx, video_bytes, ext in presentation.slide_videos:
            if ext not in MEDIA_TYPES or not ext.startswith((".mp4", ".m4v", ".webm", ".mov")):
                continue
            video_filename = f"{int(idx)}{ext}"
            (slides_dir / video_filename).write_bytes(video_bytes)
            if idx in slide_map:
                slide_map[idx].video_url = f"/api/slides/{presentation.id}/{video_filename}"
                logger.info("Saved embedded video for slide %d (%s, %d bytes)", idx + 1, ext, len(video_bytes))
        presentation.slide_videos = []  # free memory

    # Upload original PPTX to Blob Storage for Office Online viewing
    if store and store.available:
        store.upload_pptx(presentation.id, presentation.filename, content)
        pptx_url = store.get_pptx_url(presentation.id, presentation.filename)
        presentation.pptx_url = pptx_url
        logger.info("Uploaded PPTX to Blob Storage for %s", presentation.id)

    # Free raw PPTX bytes from memory
    presentation.pptx_bytes = None

    presentations[presentation.id] = presentation

    # Log extracted notes for debugging
    notes_found = sum(1 for s in presentation.slides if s.notes)
    logger.info(
        "Parsed %s: %d slides, %d with speaker notes",
        presentation.filename, presentation.slide_count, notes_found,
    )

    # Persist metadata to Cosmos DB (use cosmos_available — works even if Blob is unreachable)
    if store and store.cosmos_available:
        cosmos_doc = {
            "id": presentation.id,
            "filename": presentation.filename,
            "slide_count": presentation.slide_count,
            "notes_count": notes_found,
            "pptx_url": presentation.pptx_url,
            "slides": [
                {
                    "index": s.index,
                    "title": s.title,
                    "body": s.body,
                    "notes": s.notes,
                    "image_url": s.image_url,
                    "video_url": s.video_url,
                    "translated_notes": {},
                }
                for s in presentation.slides
            ],
        }
        store.save_presentation(cosmos_doc)

    # Index for Q&A in background (best-effort for PoC)
    try:
        if config and config.openai_endpoint:
            openai_client = get_openai_client(config)
            index_presentation(config, openai_client, presentation)
            logger.info("Indexed presentation %s for Q&A", presentation.id)
    except Exception as e:
        logger.warning("Failed to index for Q&A (non-blocking): %s", e)

    # Batch-translate notes for ALL supported languages in background
    if config and config.openai_endpoint and notes_found > 0:
        asyncio.create_task(_batch_translate_all_languages(presentation.id))

    return PresentationResponse(
        id=presentation.id,
        filename=presentation.filename,
        slide_count=presentation.slide_count,
        pptx_url=presentation.pptx_url,
        slides=[
            SlideResponse(
                index=s.index, title=s.title, body=s.body, notes=s.notes,
                image_url=s.image_url, video_url=s.video_url, translated_notes={},
            )
            for s in presentation.slides
        ],
    )


# --- List & Get Presentations ---


@admin_router.get("/api/presentations", response_model=list[PresentationListItem])
async def list_presentations():
    """List all uploaded presentations (from Cosmos DB if available, else in-memory)."""
    # Try Cosmos DB first
    if store and store.cosmos_available:
        cosmos_items = store.list_presentations()
        if cosmos_items:
            out: list[PresentationListItem] = []
            for item in cosmos_items:
                # The container also holds playlists etc.; skip malformed /
                # non-presentation items instead of raising KeyError.
                if not isinstance(item, dict) or not is_valid(item.get("id"), UUID_RE):
                    continue
                try:
                    slide_count = int(item.get("slide_count") or 0)
                except (TypeError, ValueError):
                    slide_count = 0
                out.append(PresentationListItem(
                    id=item["id"],
                    filename=str(item.get("filename") or item["id"]),
                    slide_count=slide_count,
                ))
            return out
    # Fallback to in-memory
    return [
        PresentationListItem(id=p.id, filename=p.filename, slide_count=p.slide_count)
        for p in presentations.values()
    ]


@admin_router.get("/api/slides/{presentation_id}", response_model=PresentationResponse)
async def get_slides(presentation_id: str):
    """Get all slides for a presentation (from memory, then Cosmos DB)."""
    require_id(presentation_id, UUID_RE, "Presentation")
    # Check in-memory first
    if presentation_id in presentations:
        p = presentations[presentation_id]
        # Fetch translated_notes from Cosmos DB so the frontend always gets cached translations
        tn_map: dict[int, dict[str, str]] = {}
        if store and store.cosmos_available:
            doc = store.get_presentation(presentation_id)
            if doc:
                tn_map = {s.get("index"): s.get("translated_notes", {}) for s in doc.get("slides", []) if isinstance(s, dict)}
        # Regenerate fresh SAS URLs (stored SAS may have expired)
        effective_pptx_url = store.get_pptx_url(p.id, p.filename) if (store and store.available) else p.pptx_url
        def _fresh_image_url(s: any) -> str:
            if store and store.available:
                return store.get_slide_image_url(p.id, s.index) or s.image_url or f"/api/slides/{p.id}/{s.index}.png"
            return s.image_url or f"/api/slides/{p.id}/{s.index}.png"
        return PresentationResponse(
            id=p.id,
            filename=p.filename,
            slide_count=p.slide_count,
            pptx_url=effective_pptx_url,
            slides=[
                SlideResponse(index=s.index, title=s.title, body=s.body, notes=s.notes,
                              image_url=_fresh_image_url(s),
                              video_url=s.video_url,
                              translated_notes=tn_map.get(s.index, {}))
                for s in p.slides
            ],
        )
    # Try Cosmos DB
    if store and store.cosmos_available:
        doc = store.get_presentation(presentation_id)
        if doc:
            # Rehydrate into in-memory cache
            from services.pptx_parser import PresentationData, SlideData
            raw_slides = [s for s in (doc.get("slides") or []) if isinstance(s, dict)]
            slides = [
                SlideData(
                    index=int(s.get("index", i)), title=s.get("title") or "", body=s.get("body") or "",
                    notes=s.get("notes") or "", image_url=s.get("image_url"),
                    video_url=s.get("video_url"),
                )
                for i, s in enumerate(raw_slides)
            ]
            pd = PresentationData(
                id=doc["id"], filename=str(doc.get("filename") or doc["id"]),
                slide_count=int(doc.get("slide_count") or len(slides)), slides=slides,
                pptx_url=doc.get("pptx_url"),
            )
            presentations[doc["id"]] = pd
            # Regenerate fresh SAS URLs for slide images (stored SAS may have expired)
            if store and store.available:
                for s in pd.slides:
                    sas_url = store.get_slide_image_url(pd.id, s.index)
                    if sas_url:
                        s.image_url = sas_url
            # Only expose pptx_url if Blob Storage is reachable; regenerate to avoid expired SAS
            effective_pptx_url = store.get_pptx_url(pd.id, pd.filename) if (store and store.available) else None
            # Build translated_notes from Cosmos doc
            tn_map = {int(s.get("index", i)): s.get("translated_notes", {}) for i, s in enumerate(raw_slides)}
            blob_ok = store and store.available
            return PresentationResponse(
                id=pd.id, filename=pd.filename, slide_count=pd.slide_count,
                pptx_url=effective_pptx_url,
                slides=[
                    SlideResponse(index=s.index, title=s.title, body=s.body,
                                  notes=s.notes,
                                  image_url=s.image_url if blob_ok else f"/api/slides/{pd.id}/{s.index}.png",
                                  video_url=s.video_url,
                                  translated_notes=tn_map.get(s.index, {}))
                    for s in pd.slides
                ],
            )
    raise HTTPException(status_code=404, detail="Presentation not found")


def _is_published_deck(presentation_id: str) -> bool:
    if not (store and store.cosmos_available):
        return False
    doc = store.get_presentation(presentation_id)
    return bool(doc and doc.get("source") == "deck" and doc.get("published") is True)


@app.get("/api/slides/{presentation_id}/{filename}")
async def get_slide_image(
    presentation_id: str,
    filename: str,
    principal: Principal = Depends(get_principal),
):
    """Serve rendered slide images and extracted video files.

    Admin-only, except PNG slide images of *published* catalog decks.
    """
    match = SLIDE_FILE_RE.fullmatch(filename or "")
    if not is_valid(presentation_id, UUID_RE) or not match:
        raise HTTPException(status_code=404, detail="Slide image not found")
    if not principal.is_admin:
        if not (match.group(2) == "png" and _is_published_deck(presentation_id)):
            if not principal.authenticated:
                raise HTTPException(status_code=401, detail="Sign-in required")
            raise HTTPException(status_code=403, detail="Not authorized")
    file_path = safe_join(SLIDES_DIR, presentation_id, filename)
    if file_path is None:
        raise HTTPException(status_code=404, detail="Slide image not found")
    media_type = MEDIA_TYPES[file_path.suffix.lower()]
    if file_path.is_file():
        return FileResponse(file_path, media_type=media_type)
    # Try downloading from Blob Storage and cache locally (PNG images only)
    if store and store.cosmos_available and store.available and match.group(2) == "png":
        data = store.download_slide_image(presentation_id, int(match.group(1)))
        if data:
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_bytes(data)
            return FileResponse(file_path, media_type="image/png")
    raise HTTPException(status_code=404, detail="Slide image not found")


# --- Delete & Share ---


@admin_router.delete("/api/presentations/{presentation_id}")
async def delete_presentation(presentation_id: str):
    """Delete a presentation and its slide images from Cosmos DB, Blob Storage, and local disk."""
    require_id(presentation_id, UUID_RE, "Presentation")
    deleted_any = False

    # Remove from in-memory store
    if presentation_id in presentations:
        del presentations[presentation_id]
        deleted_any = True

    # Remove from Cosmos DB + Blob Storage
    if store and store.available:
        store.delete_presentation(presentation_id)
        store.delete_slide_images(presentation_id)
        deleted_any = True

    # Remove local disk cache
    slides_dir = safe_join(SLIDES_DIR, presentation_id)
    if slides_dir is not None and slides_dir.is_dir() and slides_dir != SLIDES_DIR.resolve():
        import shutil
        shutil.rmtree(slides_dir, ignore_errors=True)
        deleted_any = True

    if not deleted_any:
        raise HTTPException(status_code=404, detail="Presentation not found")

    logger.info("Deleted presentation %s", presentation_id)
    return {"status": "deleted", "id": presentation_id}


@admin_router.post("/api/presentations/{presentation_id}/share")
async def share_presentation(presentation_id: str):
    """Share a presentation (placeholder — not yet implemented)."""
    require_id(presentation_id, UUID_RE, "Presentation")
    if presentation_id not in presentations:
        if not (store and store.cosmos_available and store.get_presentation(presentation_id)):
            raise HTTPException(status_code=404, detail="Presentation not found")
    # TODO: implement sharing logic (generate shareable link, etc.)
    return {"status": "not_implemented", "message": "Sharing is not yet available."}


# --- Pre-translate Notes ---

# Track background translation progress per presentation
_translation_progress: dict[str, dict] = {}


async def _batch_translate_all_languages(presentation_id: str):
    """Background task: translate notes into all supported languages and cache in Cosmos."""
    _translation_progress[presentation_id] = {
        "total": len(SUPPORTED_LANGUAGES),
        "completed": 0,
        "languages_done": [],
        "status": "in_progress",
    }
    logger.info("Starting batch translation for %s (%d languages)", presentation_id, len(SUPPORTED_LANGUAGES))

    for lang in SUPPORTED_LANGUAGES:
        try:
            # Reuse the existing translate-notes logic internally
            req = TranslateNotesRequest(target_language=lang)
            await translate_notes(presentation_id, req)
            _translation_progress[presentation_id]["completed"] += 1
            _translation_progress[presentation_id]["languages_done"].append(lang)
            logger.info("Batch translate %s: %s done", presentation_id, lang)
        except Exception as e:
            logger.warning("Batch translate %s failed for %s: %s", presentation_id, lang, e)
            _translation_progress[presentation_id]["completed"] += 1

    _translation_progress[presentation_id]["status"] = "completed"
    logger.info("Batch translation complete for %s", presentation_id)


@admin_router.get("/api/presentations/{presentation_id}/translations-status")
async def translations_status(presentation_id: str):
    """Check status of background batch translation for a presentation."""
    require_id(presentation_id, UUID_RE, "Presentation")
    progress = _translation_progress.get(presentation_id)
    if progress:
        return progress

    # If no background task tracked, check Cosmos for existing translations
    if store and store.cosmos_available:
        doc = store.get_presentation(presentation_id)
        if doc:
            # Count which languages already have cached translations
            all_langs = set()
            for slide in doc.get("slides", []):
                all_langs.update(slide.get("translated_notes", {}).keys())
            return {
                "total": len(SUPPORTED_LANGUAGES),
                "completed": len(all_langs),
                "languages_done": sorted(all_langs),
                "status": "completed" if len(all_langs) >= len(SUPPORTED_LANGUAGES) else "unknown",
            }

    return {"total": len(SUPPORTED_LANGUAGES), "completed": 0, "languages_done": [], "status": "not_started"}


@admin_router.post(
    "/api/presentations/{presentation_id}/translate-notes",
    response_model=TranslateNotesResponse,
    dependencies=[Depends(consume_quota)],
)
async def translate_notes(presentation_id: str, req: TranslateNotesRequest):
    """Pre-translate all slide notes for a language and cache in Cosmos DB.

    First call translates via Azure OpenAI and stores results in Cosmos DB.
    Subsequent calls for the same language return cached translations instantly.
    """
    if not config or not config.openai_endpoint:
        raise HTTPException(status_code=503, detail="Translation service not configured")
    require_id(presentation_id, UUID_RE, "Presentation")

    target_lang = req.target_language

    # Load slides from Cosmos or in-memory
    cosmos_doc = None
    if store and store.cosmos_available:
        cosmos_doc = store.get_presentation(presentation_id)

    p = presentations.get(presentation_id)
    if not cosmos_doc and not p:
        raise HTTPException(status_code=404, detail="Presentation not found")

    # Build working list of slides (prefer Cosmos as it has cached translations)
    if cosmos_doc:
        slides_data = cosmos_doc.get("slides", [])
    else:
        slides_data = [
            {"index": s.index, "notes": s.notes, "translated_notes": {}}
            for s in p.slides
        ]
        # Try to build cosmos_doc from in-memory so translations can be persisted
        if store and store.cosmos_available:
            cosmos_doc = {
                "id": p.id,
                "filename": p.filename,
                "slide_count": p.slide_count,
                "pptx_url": p.pptx_url,
                "notes_count": sum(1 for s in p.slides if s.notes),
                "slides": slides_data,
            }
            store.save_presentation(cosmos_doc)

    # Separate cached vs. needs-translation
    to_translate = []
    result_map: dict[int, str] = {}

    for sd in slides_data:
        notes = sd.get("notes", "")
        if not notes.strip():
            continue
        cached = sd.get("translated_notes", {}).get(target_lang)
        if cached:
            result_map[sd["index"]] = cached
        else:
            to_translate.append(sd)

    all_cached = len(to_translate) == 0

    # Translate missing notes concurrently
    if to_translate:
        openai_client = get_openai_client(config)
        loop = asyncio.get_event_loop()

        async def _translate_one(slide_doc: dict) -> tuple[int, str]:
            translated = await loop.run_in_executor(
                None,
                translate_text,
                openai_client,
                slide_doc["notes"],
                target_lang,
                config.openai_chat_deployment,
            )
            return slide_doc["index"], translated

        results = await asyncio.gather(*[_translate_one(sd) for sd in to_translate])
        new_translations = dict(results)
        result_map.update(new_translations)

        # Persist new translations in Cosmos DB
        if cosmos_doc and store and store.cosmos_available:
            for slide_doc in cosmos_doc["slides"]:
                idx = slide_doc["index"]
                if idx in new_translations:
                    if "translated_notes" not in slide_doc:
                        slide_doc["translated_notes"] = {}
                    slide_doc["translated_notes"][target_lang] = new_translations[idx]
            store.save_presentation(cosmos_doc)
            logger.info(
                "Cached %d translated notes (%s) for %s",
                len(new_translations), target_lang, presentation_id,
            )

    return TranslateNotesResponse(
        presentation_id=presentation_id,
        target_language=target_lang,
        translated_slides=[
            TranslatedSlide(index=idx, translated_notes=text)
            for idx, text in sorted(result_map.items())
        ],
        cached=all_cached,
    )


# --- Translation ---


@admin_router.post("/api/translate", response_model=TranslateResponse, dependencies=[Depends(consume_quota)])
async def translate(req: TranslateRequest):
    """Translate text to target language."""
    if not config:
        raise HTTPException(status_code=503, detail="Service not configured")

    openai_client = get_openai_client(config)
    source_lang = detect_language(openai_client, req.text, config.openai_chat_deployment)
    translated = translate_text(
        openai_client, req.text, req.target_language, config.openai_chat_deployment
    )
    return TranslateResponse(translated_text=translated, source_language=source_lang)


# --- Avatar ---


# NOTE: there is intentionally no token-vending endpoint. Speech / Voice Live
# credentials never leave the server; the browser talks to the server-side
# `/ws/voice` proxy instead.


@app.websocket("/ws/voice")
async def voice_websocket(ws: WebSocket):
    """WebSocket proxy for Azure Voice Live API — real-time avatar streaming.

    Authorization and Origin checks happen BEFORE the handshake is accepted.
    """
    principal = auth.principal_from_headers(ws.headers)
    if not principal.authenticated:
        await ws.close(code=4401, reason="Sign-in required")
        return
    if not principal.is_admin:
        await ws.close(code=4403, reason="Not authorized")
        return
    if not origin_allowed(ws.headers):
        await ws.close(code=4403, reason="Origin not allowed")
        return
    if not config:
        await ws.close(code=1011, reason="Service not configured")
        return
    # Authorised caller from here on: accept first so the browser can read the
    # close code/reason for capacity/quota errors (pre-accept closes arrive as 1006).
    if not VOICE_SESSIONS.try_acquire():
        await ws.accept()
        await ws.close(code=1013, reason="Avatar at capacity, try again later")
        return

    try:
        try:
            DAILY_QUOTA.consume(principal.user_id)
        except HTTPException:
            await ws.accept()
            await ws.close(code=4429, reason="Daily quota exceeded")
            return

        await ws.accept()
        logger.info("Voice WebSocket client connected")
        try:
            async with asyncio.timeout(max_voice_session_seconds()):
                await _run_voice_session(ws, principal)
        except TimeoutError:
            logger.info("Voice WebSocket session reached the time cap")
            try:
                await ws.close(code=4408, reason="Session time limit reached")
            except Exception:
                pass
        except WebSocketDisconnect:
            logger.info("Voice WebSocket client disconnected")
        except Exception as e:
            logger.error("Voice WebSocket error: %s", e)
            try:
                await ws.close(code=1011, reason="Voice session error")
            except Exception:
                pass
    finally:
        VOICE_SESSIONS.release()


def _qa_slides_from_doc(doc: dict) -> Optional[list[dict]]:
    slides = []
    for i, s in enumerate(doc.get("slides") or []):
        if not isinstance(s, dict):
            continue
        idx = s.get("index", i)
        slides.append({
            "index": idx if isinstance(idx, int) and not isinstance(idx, bool) else i,
            "title": s.get("title") or "", "body": s.get("body") or "", "notes": s.get("notes") or "",
        })
    return slides or None


def _load_qa_slides(deck_id: Optional[str] = None, presentation_id: Optional[str] = None) -> Optional[list[dict]]:
    """Server-side slides (title / body / notes) for voice Q&A: a catalog deck
    (``deck_id``) or a legacy Live upload (``presentation_id``, in-memory
    first, then Cosmos). ``None`` when unknown."""
    try:
        if deck_id:
            if not is_valid(deck_id, UUID_RE) or not (store and store.cosmos_available):
                return None
            doc = store.get_presentation(deck_id)
            if not isinstance(doc, dict) or doc.get("source") != "deck":
                return None
            return _qa_slides_from_doc(doc)
        if presentation_id:
            if not is_valid(presentation_id, UUID_RE):
                return None
            p = presentations.get(presentation_id)
            if p is not None:
                return [
                    {"index": s.index, "title": s.title or "", "body": s.body or "", "notes": s.notes or ""}
                    for s in p.slides
                ] or None
            if store and store.cosmos_available:
                doc = store.get_presentation(presentation_id)
                if isinstance(doc, dict):
                    return _qa_slides_from_doc(doc)
    except Exception:
        logger.exception("Voice Q&A deck lookup failed")
    return None


async def _run_voice_session(ws: WebSocket, principal: Optional[Principal] = None) -> None:
    # Wait for the initial session.update from the client. Only avatar id,
    # language and voice are honoured (each resolved against an allowlist);
    # client-supplied instructions / system prompts are ignored. An optional
    # deck_id / presentation_id binds the deck used for raise-hand Q&A.
    first_msg = await ws.receive_text()
    if len(first_msg) > 16_384:
        await ws.close(code=1009, reason="Message too large")
        return
    try:
        msg = json.loads(first_msg)
    except json.JSONDecodeError:
        msg = {}

    avatar_id = ""
    language = "en-US"
    voice_name = None
    deck_id: Optional[str] = None
    presentation_id: Optional[str] = None

    if isinstance(msg, dict) and msg.get("type") == "session.update":
        session = msg.get("session") or {}
        if isinstance(session, dict):
            avatar = session.get("avatar") or {}
            if isinstance(avatar, dict) and isinstance(avatar.get("character"), str):
                avatar_id = avatar["character"][:64]
            if isinstance(session.get("language"), str):
                language = session["language"][:16]
            voice = session.get("voice")
            if isinstance(voice, str) and voice.strip():
                voice_name = voice.strip()[:100]
            elif isinstance(voice, dict):
                candidate = voice.get("name")
                if isinstance(candidate, str) and candidate.strip():
                    voice_name = candidate.strip()[:100]
            if isinstance(session.get("deck_id"), str):
                deck_id = session["deck_id"][:64]
            elif isinstance(session.get("presentation_id"), str):
                presentation_id = session["presentation_id"][:64]

    slides = None
    if deck_id or presentation_id:
        slides = await asyncio.to_thread(_load_qa_slides, deck_id, presentation_id)
    user_id = principal.user_id if principal is not None else "local-dev"

    async def reserve_daily() -> Optional[str]:
        try:
            DAILY_QUOTA.consume(user_id)
        except HTTPException:
            return "quota"
        return None

    async def deck_loader(new_deck_id: str) -> Optional[list]:
        return await asyncio.to_thread(_load_qa_slides, new_deck_id, None)

    qa = QaOptions(
        access="admin",
        enabled=True,
        max_questions=ADMIN_MAX_QUESTIONS,
        slides=slides,
        deck_id=deck_id if slides else None,
        deck_loader=deck_loader,
        reserve_daily=reserve_daily,
    )
    await handle_voice_proxy(
        client_ws=ws,
        config=config,
        avatar_character=avatar_id if avatar_registry.is_known(avatar_id) else "",
        language=language,
        voice_name=voice_name,
        qa=qa,
    )


# --- Public live-avatar demo (anonymous, narration-only) ---


@admin_router.get("/api/admin/client-ip")
async def admin_client_ip(request: Request):
    """Admin diagnostic: the client IP used for per-IP demo quotas and the raw
    forwarding headers (to validate the proxy chain, e.g. after adding a CDN)."""
    return {
        "client_ip": client_ip(request.headers, request.client.host if request.client else None),
        "x_forwarded_for": request.headers.get("x-forwarded-for"),
        "x_real_ip": request.headers.get("x-real-ip"),
        "x_original_forwarded_for": request.headers.get("x-original-forwarded-for"),
        "peer": request.client.host if request.client else None,
    }


@app.get("/api/demo/config")
async def demo_config():
    """Anonymous: whether the narration-only live avatar demo is available,
    the effective session cap and the raise-hand Q&A settings."""
    enabled = public_demo_enabled()
    out: dict = {
        "enabled": enabled,
        "session_seconds": effective_demo_session_seconds(),
        "qa": {
            "enabled": enabled and demo_qa_enabled(),
            "max_questions": demo_qa_max_questions(),
            "max_audio_seconds": MAX_AUDIO_SECONDS,
        },
    }
    if enabled:
        out["remaining_today"] = await asyncio.to_thread(DEMO_QUOTA.remaining_today)
    return out


def _live_demo_deck(deck_id: str) -> Optional[dict]:
    """The stored catalog deck when it is published AND marked live demo."""
    if not (store and store.cosmos_available):
        return None
    try:
        doc = store.get_presentation(deck_id)
    except Exception:
        logger.exception("Demo deck lookup failed")
        return None
    if not isinstance(doc, dict) or doc.get("source") != "deck":
        return None
    if doc.get("published") is not True or doc.get("live_demo") is not True:
        return None
    return doc


@app.websocket("/ws/voice/demo")
async def demo_voice_websocket(ws: WebSocket):
    """Anonymous narration-only avatar for decks marked "Live demo".

    Pre-accept (4403): kill switch, deck id format, Origin, deck published +
    live_demo. Post-accept (so browsers can read the code): 1013 when the demo
    slot is taken, 4429 daily quota (global sessions, minutes or per IP), 4503
    when the quota store is busy or unavailable, 4408 at the session time cap,
    4001 when the visitor finishes, 4002 when idle after the narration and
    1011 when the avatar service fails (contracts §4).
    """
    deck_id = ws.query_params.get("deck_id") or ""
    if (os.environ.get("LOG_FORWARDING_CHAIN") or "").strip().lower() in {"1", "true", "yes", "on"}:
        # Temporary operator diagnostic (off by default): validates which hop
        # of the proxy chain carries the real client IP.
        logger.info(
            "Forwarding chain: peer=%s xff=%s x-original-forwarded-for=%s x-real-ip=%s "
            "x-envoy-external-address=%s x-azure-clientip=%s forwarded=%s",
            ws.client.host if ws.client else None,
            ws.headers.get("x-forwarded-for"), ws.headers.get("x-original-forwarded-for"),
            ws.headers.get("x-real-ip"), ws.headers.get("x-envoy-external-address"),
            ws.headers.get("x-azure-clientip"), ws.headers.get("forwarded"),
        )
    if not public_demo_enabled():
        await ws.close(code=4403, reason="Demo not available")
        return
    if not is_valid(deck_id, UUID_RE):
        await ws.close(code=4403, reason="Demo not available for this deck")
        return
    if not origin_allowed(ws.headers):
        await ws.close(code=4403, reason="Origin not allowed")
        return
    # Storage can be slow on the first call: keep it off the event loop that carries the live sessions.
    deck = await asyncio.to_thread(_live_demo_deck, deck_id)
    if not deck:
        await ws.close(code=4403, reason="Demo not available for this deck")
        return
    if not config:
        await ws.close(code=1011, reason="Service not configured")
        return
    if not DEMO_SESSIONS.try_acquire():
        await ws.accept()
        await ws.close(code=1013, reason="The demo avatar is busy, try again in a minute")
        return

    try:
        ip = client_ip(ws.headers, ws.client.host if ws.client else None)
        exempt = demo_quota_exempt(ip)
        if exempt:
            logger.info("Demo session quota-exempt (allowlisted client IP)")
            exhausted = None
        else:
            exhausted = await asyncio.to_thread(DEMO_QUOTA.try_consume, ip)
        if exhausted:
            logger.info("Demo session refused: %s", exhausted)
            # Budget used up -> 4429; the quota store busy or down -> 4503 (never "another visitor is using it").
            refusal = dp.QUOTA_REFUSAL_TO_CLOSE.get(exhausted, dp.CLOSE_STORE_OUTAGE)
            await ws.accept()
            if refusal == dp.CLOSE_DAILY_QUOTA:
                await ws.close(code=4429, reason="Daily demo limit reached, come back tomorrow")
            else:
                await ws.close(code=4503, reason="Live demo temporarily unavailable")
            return

        slides = [s for s in (deck.get("slides") or []) if isinstance(s, dict)]
        language = deck.get("language") if isinstance(deck.get("language"), str) else "en-US"
        avatar_q = ws.query_params.get("avatar")
        session_cap = effective_demo_session_seconds()
        await ws.accept()
        logger.info("Demo voice session started (deck=%s)", deck_id)
        started = time.monotonic()
        deadline = started + session_cap

        async def reserve_question() -> Optional[str]:
            if exempt:
                return None
            return await asyncio.to_thread(DEMO_QUOTA.try_reserve_question, ip)

        qa = QaOptions(
            access="demo",
            enabled=demo_qa_enabled(),
            max_questions=demo_qa_max_questions(),
            slides=slides,
            deck_id=deck_id,
            reserve_daily=reserve_question,
            deadline=deadline,
            language=language or "en-US",
        )
        try:
            narration_chars = demo_narration_chars(slides)
            await ws.send_json({"type": dp.MSG_STARTED, "session_seconds": session_cap,
                                "remaining_ms": session_cap * 1000,
                                "narration_chars": narration_chars,
                                "protocol": dp.PROTOCOL_VERSION,
                                "slide_count": len(narration_chars),
                                "idle_close_seconds": dp.IDLE_CLOSE_SECONDS})
            async with asyncio.timeout(session_cap):
                close = await handle_demo_proxy(
                    ws,
                    config,
                    language=language or "en-US",
                    slides=slides,
                    max_speaks=demo_max_speaks(len(slides)),
                    avatar_id=avatar_q[:64] if avatar_q else None,
                    deadline=deadline,
                    qa=qa,
                )
            try:
                if close is None:
                    await ws.close(code=dp.CLOSE_NORMAL)
                else:
                    # 4001 finished, 4002 idle, 1011 avatar service failure (after its `error` event).
                    await ws.close(code=close[0], reason=close[1])
            except Exception:
                pass
        except TimeoutError:
            logger.info("Demo voice session reached the time cap")
            try:
                await ws.close(code=4408, reason="Demo time limit reached")
            except Exception:
                pass
        except WebSocketDisconnect:
            logger.info("Demo voice client disconnected")
        except Exception as e:
            logger.error("Demo voice session error: %s", e)
            try:
                await ws.close(code=1011, reason="Demo session error")
            except Exception:
                pass
        finally:
            if not exempt:
                await asyncio.to_thread(DEMO_QUOTA.add_seconds, time.monotonic() - started)
    finally:
        DEMO_SESSIONS.release()


MAX_BATCH_TEXT_CHARS = 50_000


@admin_router.post("/api/avatar/batch", response_model=BatchAvatarResponse, dependencies=[Depends(consume_quota)])
async def start_batch_avatar(req: BatchAvatarRequest):
    """Start a batch avatar video generation job."""
    if not config:
        raise HTTPException(status_code=503, detail="Service not configured")

    if req.presentation_id not in presentations:
        raise HTTPException(status_code=404, detail="Presentation not found")

    presentation = presentations[req.presentation_id]
    texts = [s.notes or s.body or s.title for s in presentation.slides]
    if sum(len(t or "") for t in texts) > MAX_BATCH_TEXT_CHARS:
        raise HTTPException(status_code=400, detail="Presentation text too long for batch synthesis")

    # Translate if needed
    if req.target_language != "en-US":
        openai_client = get_openai_client(config)
        translated_texts = []
        for text in texts:
            if text:
                translated = translate_text(
                    openai_client, text, req.target_language, config.openai_chat_deployment
                )
                translated_texts.append(translated)
            else:
                translated_texts.append("")
        texts = translated_texts

    job_id = submit_batch_synthesis(config, texts, req.target_language, req.avatar)
    return BatchAvatarResponse(job_id=job_id, status="submitted")


@admin_router.get("/api/avatar/batch/{job_id}")
async def check_batch_status(job_id: str):
    """Check the status of a batch avatar generation job."""
    require_id(job_id, UUID_RE, "Job")
    if not config:
        raise HTTPException(status_code=503, detail="Service not configured")
    status = get_batch_synthesis_status(config, job_id)
    return {
        "job_id": status.job_id,
        "status": status.status,
        "video_url": status.video_url,
        "error": status.error,
    }


# --- Agent Chat (Function-Calling) ---


class AgentChatMessage(BaseModel):
    role: str = Field("user", max_length=16)
    content: str = Field(..., max_length=MAX_CHAT_MESSAGE_CHARS)


class AgentChatRequest(BaseModel):
    messages: list[AgentChatMessage] = Field(..., max_length=100)
    presentation_id: Optional[str] = Field(None, max_length=64)
    slide_index: Optional[int] = Field(None, ge=0, le=10000)


def sanitize_chat_history(messages: list[AgentChatMessage]) -> list[dict]:
    """Keep only user/assistant turns (client `system`/`tool` roles are dropped)
    and cap the history to the most recent ``MAX_CHAT_MESSAGES`` turns."""
    kept = [
        {"role": m.role, "content": m.content[:MAX_CHAT_MESSAGE_CHARS]}
        for m in messages
        if m.role in {"user", "assistant"}
    ]
    return kept[-MAX_CHAT_MESSAGES:]


# Tool definitions for Azure OpenAI function calling
AGENT_TOOLS_SCHEMA = [
    {
        "type": "function",
        "function": {
            "name": "translate_slide_notes",
            "description": "Translate presentation slide text to a target language.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Source text to translate"},
                    "target_language": {"type": "string", "description": "BCP-47 code like 'fr-FR', 'es-ES', 'en-US'"},
                },
                "required": ["text", "target_language"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "detect_text_language",
            "description": "Detect the language of a given text. Returns a BCP-47 code.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Text to analyze"},
                },
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ask_about_slides",
            "description": "Answer a question about presentation slides based on provided slide content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "slide_context": {"type": "string", "description": "Slide content (title, body, notes)"},
                    "question": {"type": "string", "description": "User's question about the slides"},
                },
                "required": ["slide_context", "question"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "generate_avatar_speech_ssml",
            "description": "Generate SSML markup for avatar text-to-speech.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Text the avatar should speak"},
                    "language": {"type": "string", "description": "BCP-47 language code"},
                },
                "required": ["text", "language"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "prepare_slide_for_presentation",
            "description": "Translate speaker notes and generate SSML for the avatar. Use when asked to present a slide in a specific language.",
            "parameters": {
                "type": "object",
                "properties": {
                    "slide_title": {"type": "string"},
                    "slide_body": {"type": "string"},
                    "slide_notes": {"type": "string"},
                    "target_language": {"type": "string", "description": "BCP-47 code for the output"},
                },
                "required": ["slide_title", "slide_body", "slide_notes", "target_language"],
            },
        },
    },
]

AGENT_SYSTEM_PROMPT = """\
You are the Oz Radio Assistant — an AI-powered avatar presentation helper.

## Your Capabilities (via tools)
- **translate_slide_notes**: Translate text (e.g., speaker notes) to French, Spanish, or English.
- **detect_text_language**: Detect the language of a given text.
- **ask_about_slides**: Answer questions about slide content when given the slide text.
- **generate_avatar_speech_ssml**: Generate SSML markup for avatar text-to-speech.
- **prepare_slide_for_presentation**: All-in-one: translate speaker notes and generate SSML for the avatar.

## Behavioral Guidelines
1. When the user asks to present a slide, use **prepare_slide_for_presentation**.
2. When the user asks a question about slides, use **ask_about_slides** with the slide content as context.
3. When the user asks for translation only, use **translate_slide_notes**.
4. Always be concise. If a tool returns JSON, extract the relevant fields for the user.
5. If the user does not specify a language, default to English (en-US).
"""


def _execute_tool_call(name: str, arguments: dict) -> str:
    """Execute one of the registered agent tools and return the result."""
    from agent_tools import (
        translate_slide_notes,
        detect_text_language,
        ask_about_slides,
        generate_avatar_speech_ssml,
        prepare_slide_for_presentation,
    )
    dispatch = {
        "translate_slide_notes": lambda a: translate_slide_notes(a["text"], a["target_language"]),
        "detect_text_language": lambda a: detect_text_language(a["text"]),
        "ask_about_slides": lambda a: ask_about_slides(a["slide_context"], a["question"]),
        "generate_avatar_speech_ssml": lambda a: generate_avatar_speech_ssml(a["text"], a["language"]),
        "prepare_slide_for_presentation": lambda a: prepare_slide_for_presentation(
            a["slide_title"], a["slide_body"], a["slide_notes"], a["target_language"]
        ),
    }
    fn = dispatch.get(name)
    if not fn:
        return json.dumps({"error": f"Unknown tool: {name}"})
    try:
        return fn(arguments)
    except Exception as e:
        logger.error("Tool %s failed: %s", name, e)
        return json.dumps({"error": str(e)})




def _run_agent_sync(openai_client, model: str, messages: list[dict]) -> str:
    """Run the function-calling loop synchronously (called via to_thread)."""
    for _ in range(5):
        response = openai_client.chat.completions.create(
            model=model,
            messages=messages,
            tools=AGENT_TOOLS_SCHEMA,
            tool_choice="auto",
            temperature=0.3,
            max_completion_tokens=2048,
        )
        choice = response.choices[0]

        if choice.finish_reason == "tool_calls" and choice.message.tool_calls:
            messages.append(choice.message.model_dump())
            for tc in choice.message.tool_calls:
                args = json.loads(tc.function.arguments)
                result = _execute_tool_call(tc.function.name, args)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result,
                })
        else:
            return choice.message.content or ""

    return "I ran into an issue processing your request. Please try again."


@admin_router.post("/api/agent/chat", dependencies=[Depends(consume_quota)])
async def agent_chat(req: AgentChatRequest):
    """Multi-turn agent chat with function-calling tools.

    Uses Azure OpenAI function calling to let the LLM decide which tools
    to invoke (translate, Q&A, SSML generation, etc.) based on user intent.
    """
    if not config:
        raise HTTPException(status_code=503, detail="Service not configured")

    openai_client = get_openai_client(config)

    # Build message list for the LLM
    messages: list[dict] = [{"role": "system", "content": AGENT_SYSTEM_PROMPT}]

    # Inject slide context if available
    if req.presentation_id and req.presentation_id in presentations:
        p = presentations[req.presentation_id]
        if req.slide_index is not None and req.slide_index < len(p.slides):
            s = p.slides[req.slide_index]
            context_msg = (
                f"[Current slide context — Slide {s.index + 1}]\n"
                f"Title: {s.title}\nBody: {s.body}\nNotes: {s.notes}"
            )
            messages.append({"role": "system", "content": context_msg})

    # Append conversation history from the client (no client system prompts)
    history = sanitize_chat_history(req.messages)
    if not history or history[-1]["role"] != "user":
        raise HTTPException(status_code=400, detail="The last message must be a user message")
    messages.extend(history)

    # Run sync OpenAI calls in a thread to avoid blocking the event loop
    reply = await asyncio.to_thread(
        _run_agent_sync, openai_client, config.openai_chat_deployment, messages
    )
    return {"reply": reply}


# --- Q&A ---


@admin_router.post("/api/qa", response_model=QaResponse, dependencies=[Depends(consume_quota)])
async def slide_qa(req: QaRequest):
    """Ask a question about slide content."""
    if not config:
        raise HTTPException(status_code=503, detail="Service not configured")

    if req.presentation_id not in presentations:
        raise HTTPException(status_code=404, detail="Presentation not found")

    openai_client = get_openai_client(config)
    result = answer_question(
        config, openai_client, req.question, req.presentation_id, req.slide_index
    )
    return QaResponse(answer=result["answer"], source_slides=result["source_slides"])


# --- Teams Tab Configuration Page (for meeting tabs) ---

from fastapi.responses import HTMLResponse


@app.get("/teams-config", response_class=HTMLResponse)
async def teams_config():
    """Serve the Teams tab configuration page for meeting/channel tabs."""
    return HTMLResponse(content="""<!DOCTYPE html>
<html>
<head>
    <title>Oz Radio — Tab Configuration</title>
    <script src="https://res.cdn.office.net/teams-js/2.7.1/js/MicrosoftTeams.min.js"></script>
</head>
<body style="font-family:Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5;">
    <div style="text-align:center;">
        <h2>Oz Radio</h2>
        <p>Click Save to add Oz Radio to this meeting.</p>
    </div>
    <script>
        (async () => {
            await microsoftTeams.app.initialize();
            microsoftTeams.pages.config.registerOnSaveHandler((saveEvent) => {
                microsoftTeams.pages.config.setConfig({
                    suggestedDisplayName: "Oz Radio",
                    entityId: "presenter-meeting",
                    contentUrl: window.location.origin,
                    websiteUrl: window.location.origin
                });
                saveEvent.notifySuccess();
            });
            microsoftTeams.pages.config.setValidityState(true);
        })();
    </script>
</body>
</html>""")


# All admin-only legacy routes are registered before the SPA catch-all.
app.include_router(admin_router)


# --- Static Files (Frontend SPA) ---

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

if os.path.isdir(os.path.join(STATIC_DIR, "assets")):
    app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")

_NO_CACHE = {"Cache-Control": "no-cache, no-store, must-revalidate"}

ASSET_IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
ASSET_SHORT_CACHE = "public, max-age=3600"
# Vite build output is named ``<name>-<hash>.<ext>`` with an 8-char base64url
# hash, e.g. ``index-QO2cPfnY.js`` or ``...-normal-Dg-wlmqe.woff2``.
_ASSET_HASH_RE = re.compile(r"-([A-Za-z0-9_-]{8})(?:\.[A-Za-z0-9]+)+$")
# Text-like formats worth gzipping (images, audio/video and woff/woff2 are already compressed).
_COMPRESSIBLE_ASSET_EXTS = frozenset({
    ".js", ".mjs", ".css", ".map", ".json", ".webmanifest", ".svg", ".xml", ".txt",
    ".wasm", ".ttf", ".otf", ".eot", ".ico",
})


def asset_cache_control(name: str) -> str:
    """``Cache-Control`` for a file under ``/assets``: immutable only when content-hashed."""
    match = _ASSET_HASH_RE.search(name)
    # Real hashes mix in a capital or a digit; "-standard.css" is just a name.
    hashed = match is not None and any(c.isupper() or c.isdigit() for c in match.group(1))
    return ASSET_IMMUTABLE_CACHE if hashed else ASSET_SHORT_CACHE


class StaticAssetDeliveryMiddleware:
    """Pure-ASGI gzip + caching policy for the SPA build under ``/assets/`` only.

    Every other path (API, media, index.html, root static files) passes through
    untouched. For ``/assets/*``:

    - gzip via Starlette's ``GZipMiddleware`` (bodies >= 1 KB) for text-like
      files when the client accepts it, never for ``Range`` requests;
    - ``Vary: Accept-Encoding`` on compressible files (304s included);
    - ``Cache-Control`` on 200/206/304 (errors untouched): content-hashed Vite
      files are immutable for a year, other files are cached for an hour;
    - gzip responses (and their 304s) get a weak ETag, as nginx does: the strong
      one describes the identity bytes. ``If-None-Match`` still matches it.
    """

    def __init__(self, app, prefix: str = "/assets/", minimum_size: int = 1024, compresslevel: int = 6) -> None:
        self.app = app
        self.prefix = prefix
        self.gzip = GZipMiddleware(app, minimum_size=minimum_size, compresslevel=compresslevel)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith(self.prefix):
            await self.app(scope, receive, send)
            return

        name = scope["path"].rsplit("/", 1)[-1]
        cache_control = asset_cache_control(name)
        compressible = os.path.splitext(name)[1].lower() in _COMPRESSIBLE_ASSET_EXTS
        request_headers = Headers(scope=scope)
        use_gzip = compressible and "range" not in request_headers
        accepts_gzip = use_gzip and "gzip" in request_headers.get("accept-encoding", "")

        async def send_wrapper(message):
            if message["type"] == "http.response.start" and message["status"] in (200, 206, 304):
                message.setdefault("headers", [])
                headers = MutableHeaders(scope=message)
                if "cache-control" not in headers:
                    headers["Cache-Control"] = cache_control
                vary = {token.strip().lower() for token in headers.get("vary", "").split(",")}
                if compressible and not vary & {"accept-encoding", "*"}:
                    headers.add_vary_header("Accept-Encoding")
                etag = headers.get("etag", "")
                encoded = headers.get("content-encoding") == "gzip" or (message["status"] == 304 and accepts_gzip)
                if encoded and etag.startswith('"'):
                    headers["ETag"] = f"W/{etag}"
            await send(message)

        await (self.gzip if use_gzip else self.app)(scope, receive, send_wrapper)


# Outermost user middleware: it compresses the final body, after the security
# headers (and CORS, when enabled) have been set by the inner middlewares.
app.add_middleware(StaticAssetDeliveryMiddleware)


# ---------------------------------------------------------------------------
# Boot block: the first-paint data inlined into index.html (contracts §3)
# ---------------------------------------------------------------------------
# The built index.html carries `<!--OZ_BOOT-->`; every response for that page gets it replaced by
# `<script type="application/json" id="oz-boot">{…}</script>` so Home can render its final CTAs without an API
# waterfall after a cold start. The block only feeds rendering: authorisation is re-checked at /ws/voice/demo.
BOOT_TITLE_MAX_CHARS = 300
_BOOT_LANGUAGE_RE = re.compile(r"^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$")


class BootSnapshot(NamedTuple):
    decks: tuple[dict, ...]
    remaining_today: Optional[int]
    fetched_at: float


class BootDataCache:
    """In-memory first-paint data (live-demo decks, sessions left today) with stale-while-revalidate.

    * fresh for ``ttl`` seconds; served stale up to ``stale_max`` seconds while one background refresh runs
      (single flight, a daemon thread: the Cosmos calls block);
    * cold (nothing usable): :meth:`get` waits at most ``cold_wait`` seconds for the refresh and then answers
      ``None``, which the page turns into the fail-closed block. It never raises and never waits longer;
    * a failed refresh keeps the previous snapshot, is not retried before ``ttl`` has passed and is logged at
      WARNING at most once a minute, without client data.

    ``fetch`` runs in the refresh thread and returns ``(decks, remaining_today)``; it raises when the deck list
    cannot be read. ``clock`` drives every age (a test passes a fake one); the cold wait is real time.
    """

    _POLL_SECONDS = 0.005
    _WARN_EVERY_SECONDS = 60.0

    def __init__(
        self,
        fetch: Callable[[], tuple[tuple[dict, ...], Optional[int]]],
        *,
        clock: Callable[[], float] = time.monotonic,
        ttl: float = dp.BOOT_TTL_SECONDS,
        stale_max: float = dp.BOOT_STALE_MAX_SECONDS,
        retry: Optional[float] = None,
    ) -> None:
        self._fetch = fetch
        self._clock = clock
        self._ttl = ttl
        self._stale_max = stale_max
        self._retry = ttl if retry is None else retry
        self._lock = threading.Lock()
        self._snapshot: Optional[BootSnapshot] = None
        self._inflight: Optional[threading.Event] = None
        self._last_start: Optional[float] = None
        self._last_warn: Optional[float] = None

    def reset(self) -> None:
        """Forget everything (tests)."""
        with self._lock:
            self._snapshot = self._inflight = self._last_start = self._last_warn = None

    def warm(self) -> None:
        """Start the first refresh in the background when the demo is on. Never blocks, never raises."""
        try:
            if public_demo_enabled():
                with self._lock:
                    self._start_locked(self._clock())
        except Exception:
            logger.warning("Boot block warm-up failed to start")

    async def get(self, cold_wait: float = dp.BOOT_COLD_WAIT_SECONDS) -> Optional[BootSnapshot]:
        """A usable snapshot, or ``None`` (fail closed)."""
        now = self._clock()
        with self._lock:
            snap = self._snapshot
            age = None if snap is None else now - snap.fetched_at
            if snap is not None and age < self._ttl:
                return snap
            pending = self._start_locked(now)
            if snap is not None and age <= self._stale_max:
                return snap                       # stale but acceptable: the refresh runs in the background
        if pending is None:
            return None                           # nothing usable and no refresh to wait for
        end = time.monotonic() + max(0.0, cold_wait)
        while not pending.is_set() and time.monotonic() < end:
            await asyncio.sleep(self._POLL_SECONDS)
        with self._lock:
            snap = self._snapshot
            if snap is not None and self._clock() - snap.fetched_at <= self._stale_max:
                return snap
        return None

    def _start_locked(self, now: float) -> Optional[threading.Event]:
        """The refresh in flight, a new one when allowed, else ``None`` (still cooling down after a failure)."""
        inflight = self._inflight
        if inflight is not None and not inflight.is_set():
            return inflight                       # single flight, even while a hung call is pending
        if self._last_start is not None and now - self._last_start < self._retry:
            return None
        done = threading.Event()
        try:
            threading.Thread(target=self._refresh, args=(done,), name="oz-boot-refresh", daemon=True).start()
        except RuntimeError:                      # no thread available: fail closed, try again later
            self._last_start = now
            self._warn_locked(now, "could not start the refresh thread")
            return None
        self._inflight = done
        self._last_start = now
        return done

    def _refresh(self, done: threading.Event) -> None:
        try:
            decks, remaining = self._fetch()
        except Exception as exc:
            with self._lock:
                self._warn_locked(self._clock(), f"{type(exc).__name__}")
        else:
            snap = BootSnapshot(tuple(decks), remaining, self._clock())
            with self._lock:
                self._snapshot = snap
        finally:
            done.set()

    def _warn_locked(self, now: float, why: str) -> None:
        if self._last_warn is None or now - self._last_warn >= self._WARN_EVERY_SECONDS:
            self._last_warn = now
            logger.warning("Boot block refresh failed (%s): serving cached data or the fail-closed block", why)


def _boot_decks(rows: Any) -> tuple[dict, ...]:
    """The live-demo decks of the boot block: published AND live_demo (the ``/api/decks`` rule), sorted by
    casefolded title then id, at most ``BOOT_MAX_LIVE_DECKS``."""
    decks: list[dict] = []
    for row in rows or []:
        if not isinstance(row, dict) or row.get("published") is not True or row.get("live_demo") is not True:
            continue
        deck_id = row.get("id")
        if not is_valid(deck_id, UUID_RE):
            continue
        try:
            title = deck_title(row)[:BOOT_TITLE_MAX_CHARS]
        except Exception:
            continue
        language = row.get("language")
        decks.append({
            "deck_id": deck_id,
            "language": language if isinstance(language, str) and _BOOT_LANGUAGE_RE.fullmatch(language) else "en-US",
            "title": title,
        })
    decks.sort(key=lambda d: (d["title"].casefold(), d["deck_id"]))
    return tuple(decks[: dp.BOOT_MAX_LIVE_DECKS])


def _fetch_boot_data() -> tuple[tuple[dict, ...], Optional[int]]:
    """Blocking read of the first-paint data (runs in the refresh thread). A storage failure raises: it must
    never read as "no live decks"."""
    current = store
    if current is None:
        raise StorageUnavailable("store not initialised")
    rows = current.list_decks(strict=True)
    return _boot_decks(rows), DEMO_QUOTA.remaining_today_or_none()


_boot_cache = BootDataCache(_fetch_boot_data)


def _escape_boot_json(text: str) -> str:
    """Make compact JSON safe inside a ``<script>`` element: ``<`` ``>`` ``&`` and the two JS line separators are
    written as ``\\uXXXX`` escapes (still the same JSON string after ``JSON.parse``)."""
    return (text.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
            .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))


async def _boot_payload() -> dict:
    """The boot JSON for this request. The env flags are read now (the kill switch is immediate); the deck list
    and the sessions left come from the cache. Demo off -> ``ok:true`` at once, no Cosmos call."""
    enabled = public_demo_enabled()
    payload: dict = {
        "v": dp.BOOT_VERSION,
        "ok": True,
        "demo": {
            "enabled": enabled,
            "session_seconds": effective_demo_session_seconds(),
            "qa": {"enabled": enabled and demo_qa_enabled(), "max_questions": demo_qa_max_questions()},
            "remaining_today": None,
        },
        "live_demo_decks": [],
        # Off (the default) is exactly {"enabled": false}; on, the ingestion origin, the key and `server_cold`. Never raises.
        "telemetry": telemetry_boot(),
    }
    if not enabled:
        return payload
    snapshot = await _boot_cache.get(dp.BOOT_COLD_WAIT_SECONDS)
    if snapshot is None:
        return copy.deepcopy(dp.BOOT_FAIL_CLOSED)
    payload["demo"]["remaining_today"] = snapshot.remaining_today
    payload["live_demo_decks"] = [dict(d) for d in snapshot.decks]
    return payload


async def _boot_script_tag() -> str:
    """The ``<script id="oz-boot">`` element. ASCII only (non-ASCII text is ``\\u``-escaped), never raises."""
    try:
        payload = await _boot_payload()
    except Exception:
        logger.warning("Boot block could not be built: serving the fail-closed block")
        payload = copy.deepcopy(dp.BOOT_FAIL_CLOSED)
    body = _escape_boot_json(json.dumps(payload, separators=(",", ":"), ensure_ascii=True))
    return f'<script type="application/json" id="{dp.BOOT_ELEMENT_ID}">{body}</script>'


async def _index_response(index: Path) -> HTMLResponse:
    """``index.html`` with the boot block in place of the first ``<!--OZ_BOOT-->``. A page without the marker is
    served unchanged. Always ``no-store``: Teams and browsers must not cache the shell or the block."""
    try:
        raw = index.read_bytes()
    except OSError:
        raise HTTPException(status_code=404, detail="Not found") from None
    marker = dp.BOOT_MARKER.encode("ascii")
    if marker in raw:
        tag = await _boot_script_tag()
        raw = raw.replace(marker, tag.encode("ascii"), 1)
    return HTMLResponse(content=raw, headers=_NO_CACHE)


@app.get("/{full_path:path}")
async def serve_spa(full_path: str, request: Request):
    """Serve real files under STATIC_DIR, else index.html for client routes.

    Traversal attempts (``..``, encoded/double-encoded separators,
    backslashes, absolute paths, drive letters) and unknown files with an
    extension return 404 — never index.html.
    """
    not_found = HTTPException(status_code=404, detail="Not found")
    first = full_path.split("/", 1)[0]
    if first in {"api", "ws", ".auth"}:
        raise not_found
    raw_path = request.scope.get("raw_path") or b""
    if b"%2e" in raw_path.lower() or b"%5c" in raw_path.lower() or b"%2f" in raw_path.lower() or b"%25" in raw_path:
        raise not_found
    if not full_path:
        index = safe_join(STATIC_DIR, "index.html")
        if index and index.is_file():
            return await _index_response(index)
        raise not_found
    candidate = safe_join(STATIC_DIR, full_path)
    if candidate is None:
        raise not_found
    if candidate.is_file():
        index = safe_join(STATIC_DIR, "index.html")
        if index is not None and candidate == index:
            # An explicit /index.html is the same page: same boot block, same no-store headers.
            return await _index_response(index)
        return FileResponse(candidate)
    last = full_path.rstrip("/").rsplit("/", 1)[-1]
    if "." in last:
        raise not_found
    index = safe_join(STATIC_DIR, "index.html")
    if index and index.is_file():
        return await _index_response(index)
    raise not_found
