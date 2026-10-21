"""Decks catalog — FastAPI router.

Endpoints:
- POST   /api/decks/upload                — upload a .pptx, parse, render, index in AI Search
- GET    /api/decks                       — list all decks
- GET    /api/decks/{deck_id}             — full deck with slides (for the Present page)
- POST   /api/decks/{deck_id}/translate-notes — admin: translate + cache speaker notes for one language
- DELETE /api/decks/{deck_id}             — delete from cosmos + blob + AI Search
- POST   /api/decks/{deck_id}/publish     — show/hide a deck to anonymous viewers
- POST   /api/decks/{deck_id}/live-demo   — allow/deny the anonymous live avatar demo
- POST   /api/search                      — cross-deck hybrid semantic search

Anonymous callers may only list/view *published* decks (titles, slide images
and the slide's visible text — never body, notes or the uploaded file name);
everything else is admin-only. A read that fails because Cosmos DB is down
answers 503, never an empty list or a 404.
"""
from __future__ import annotations

import asyncio
import io
import logging
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from auth import Principal, get_principal, require_admin
from config import AzureConfig, load_config
from security import DAILY_QUOTA, UUID_RE, read_upload_limited, require_id, safe_filename
from services.demo_protocol import LIBRARY_UNAVAILABLE_DETAIL, PUBLIC_SLIDE_TEXT_MAX_CHARS
from services.pptx_parser import parse_pptx
from services.podcast_models import audience_level_or_none
from services.storage import PUBLIC_SAS_MINUTES, PresentationStore, StorageUnavailable, deck_title
from services.translation import get_openai_client, translate_text
from services.deck_search import DeckSlide, get_deck_search

log = logging.getLogger(__name__)
# Admin-only (default deny); anonymous published-deck reads are on public_router.
router = APIRouter(prefix="/api", tags=["decks"], dependencies=[Depends(require_admin)])
public_router = APIRouter(prefix="/api", tags=["decks-public"])

# Where slide PNGs are written locally — the same directory GET
# /api/slides/{id}/{n}.png (app.py) serves and caches blob downloads in.
SLIDES_DIR = Path(__file__).resolve().parent.parent / "data" / "slides"
SLIDES_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------
class DeckSummary(BaseModel):
    deck_id: str
    title: str
    slide_count: int
    language: str = "en-US"
    uploaded_at: str = ""
    tags: list[str] = []
    published: bool = False
    # Anonymous visitors may run the narration-only live avatar demo on it.
    live_demo: bool = False
    # Audience level of the deck (beginner | practitioner | expert); None when it is not recorded.
    audience_level: Optional[str] = None


class _SlideBase(BaseModel):
    index: int
    title: str
    image_url: str = ""


class PublicSlidePayload(_SlideBase):
    """Anonymous slide view: title, image and the visible text (no body, notes or translations)."""
    # The slide body, whitespace collapsed and capped (alt text for the slide image). Never speaker notes.
    text: str = ""


class SlidePayload(_SlideBase):
    """Admin slide view, including speaker notes and cached note translations.

    Deliberately not a subclass of ``PublicSlidePayload``: the admin payload has its ``body`` and no ``text``."""
    body: str = ""
    notes: str = ""
    # language code -> translated speaker notes (only values already cached in Cosmos).
    translated_notes: dict[str, str] = {}


class PublicDeckDetail(DeckSummary):
    # Aliases for frontend compatibility with existing `Presentation` shape.
    id: str = ""
    # The deck's display title, never the uploaded file name (admins get the real file name).
    filename: str = ""
    slides: list[PublicSlidePayload]


class DeckDetail(DeckSummary):
    # Aliases for frontend compatibility with existing `Presentation` shape.
    id: str = ""
    filename: str = ""
    slides: list[SlidePayload]


class TranslateDeckNotesRequest(BaseModel):
    target_language: str = Field(..., pattern=r"^[a-z]{2,3}-[A-Z]{2}$", max_length=16)


class TranslateDeckNotesResponse(BaseModel):
    deck_id: str
    target_language: str
    # str(slide index) -> translated notes
    translated_notes: dict[str, str]
    cached: bool


class UploadResponse(BaseModel):
    deck_id: str
    title: str
    slide_count: int
    indexed_slides: int


class SearchRequest(BaseModel):
    query: str = Field(..., max_length=500)
    top_k: int = 5
    language: Optional[str] = Field(None, max_length=16)


class PublishRequest(BaseModel):
    published: bool


class LiveDemoRequest(BaseModel):
    enabled: bool


class SearchResultItem(BaseModel):
    deck_id: str
    deck_title: str
    slide_index: int
    slide_title: str
    snippet: str
    score: float


class SearchResponse(BaseModel):
    results: list[SearchResultItem]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def get_cfg() -> AzureConfig:
    return load_config()


def _store(cfg: AzureConfig) -> Optional[PresentationStore]:
    try:
        s = PresentationStore(cfg)
        return s
    except Exception:
        log.exception("Could not initialise PresentationStore for decks")
        return None


def _deck_title_from_filename(filename: str) -> str:
    return filename.rsplit(".", 1)[0] if filename else "Untitled"


def _cached_translations(slide: dict) -> dict[str, str]:
    raw = slide.get("translated_notes")
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if isinstance(k, str) and isinstance(v, str) and v.strip()}


def _doc_to_summary(doc: dict) -> DeckSummary:
    return DeckSummary(
        deck_id=doc["id"],
        title=deck_title(doc),
        slide_count=int(doc.get("slide_count") or 0),
        language=doc.get("language") or "en-US",
        uploaded_at=doc.get("uploaded_at") or "",
        tags=doc.get("tags") or [],
        published=doc.get("published") is True,
        live_demo=doc.get("published") is True and doc.get("live_demo") is True,
        audience_level=audience_level_or_none(doc.get("audience_level")),
    )


def _slide_text(slide: dict) -> str:
    """Visible text of a slide for the anonymous payload: its body, whitespace collapsed within each line and one ``\\n``
    kept between non-empty lines (a reader — the picture's alt text — needs the runs apart), capped at
    ``PUBLIC_SLIDE_TEXT_MAX_CHARS`` characters (a trailing ``…`` included). Never the speaker notes."""
    body = slide.get("body")
    lines = (" ".join(line.split()) for line in body.splitlines()) if isinstance(body, str) else ()
    text = "\n".join(line for line in lines if line)
    if len(text) > PUBLIC_SLIDE_TEXT_MAX_CHARS:
        text = text[: PUBLIC_SLIDE_TEXT_MAX_CHARS - 1] + "…"
    return text


def _library_unavailable() -> HTTPException:
    """503 of a deck read whose storage is failing: never an empty list and never a 404 (contracts §2.4)."""
    return HTTPException(status_code=503, detail=LIBRARY_UNAVAILABLE_DETAIL, headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@router.post("/decks/upload", response_model=UploadResponse)
async def upload_deck(
    file: UploadFile = File(...),
    language: Optional[str] = Form(None, max_length=16),
    cfg: AzureConfig = Depends(get_cfg),
    principal: Principal = Depends(require_admin),
) -> UploadResponse:
    if not file.filename or not file.filename.lower().endswith(".pptx"):
        raise HTTPException(status_code=400, detail="Only .pptx files are supported")

    content = await read_upload_limited(file)
    if not content or content[:4] != b"PK\x03\x04":
        raise HTTPException(status_code=400, detail="Not a valid .pptx file")
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            if "[Content_Types].xml" not in zf.namelist():
                raise HTTPException(status_code=400, detail="Invalid .pptx archive")
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="Corrupted .pptx file")
    DAILY_QUOTA.consume(principal.user_id)
    return ingest_deck_bytes(content, file.filename, language, cfg)


def ingest_deck_bytes(
    content: bytes, filename: str, language: Optional[str], cfg: AzureConfig,
    *, title: Optional[str] = None,
) -> UploadResponse:
    """Parse, render, store and index an already-validated .pptx.

    Shared by the upload route and the operator maintenance CLI
    (``maintenance.content``), so both produce identical catalog decks.
    ``title`` overrides the filename-derived display title."""
    # Parse + render slides
    try:
        presentation = parse_pptx(content, safe_filename(filename, "deck.pptx"), cfg.libreoffice_path or "soffice")
    except Exception:
        log.exception("PPTX parse failed")
        raise HTTPException(status_code=400, detail="Failed to parse .pptx")

    store = _store(cfg)

    # Save rendered PNGs locally + to blob, set image_url on each slide
    if presentation.slide_images:
        out_dir = SLIDES_DIR / presentation.id
        out_dir.mkdir(parents=True, exist_ok=True)
        for idx, png in presentation.slide_images:
            (out_dir / f"{idx}.png").write_bytes(png)
            if store and store.available:
                try:
                    store.upload_slide_image(presentation.id, idx, png)
                except Exception:
                    log.warning("Blob upload failed for slide %d", idx)
        for slide in presentation.slides:
            blob_url = None
            if store and store.available:
                try:
                    blob_url = store.get_slide_image_url(presentation.id, slide.index)
                except Exception:
                    blob_url = None
            slide.image_url = blob_url or f"/api/slides/{presentation.id}/{slide.index}.png"
        presentation.slide_images = []

    # Persist metadata in Cosmos under source='deck'
    lang = (language or "").strip() or "en-US"
    display_title = (title or "").strip() or _deck_title_from_filename(presentation.filename)
    tags: list[str] = []
    uploaded_at = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": presentation.id,
        "source": "deck",
        "filename": presentation.filename,
        "title": display_title,
        "slide_count": presentation.slide_count,
        "language": lang,
        "uploaded_at": uploaded_at,
        "tags": tags,
        "published": False,
        "live_demo": False,
        "slides": [
            {
                "index": s.index,
                "title": s.title,
                "body": s.body,
                "notes": s.notes,
                "image_url": s.image_url,
                "video_url": s.video_url,
            }
            for s in presentation.slides
        ],
    }
    if store and store.cosmos_available:
        try:
            store.save_presentation(doc)
        except Exception:
            log.exception("Could not save deck %s to Cosmos", presentation.id)

    # Index in AI Search (hybrid semantic + keyword)
    indexed = 0
    try:
        openai_client = get_openai_client(cfg)
        search = get_deck_search(cfg, openai_client)
        if search:
            slides_for_index = [
                DeckSlide(
                    deck_id=presentation.id,
                    deck_title=display_title,
                    slide_index=s.index,
                    slide_title=s.title or f"Slide {s.index + 1}",
                    body=s.body or "",
                    notes=s.notes or "",
                    language=lang,
                )
                for s in presentation.slides
            ]
            indexed = search.index_deck(slides_for_index)
            log.info("Decks: indexed %d slides for deck %s", indexed, presentation.id)
        else:
            log.warning("AI Search not configured — deck %s not searchable", presentation.id)
    except Exception:
        log.exception("AI Search indexing failed for deck %s", presentation.id)

    return UploadResponse(
        deck_id=presentation.id,
        title=display_title,
        slide_count=presentation.slide_count,
        indexed_slides=indexed,
    )


@public_router.get("/decks", response_model=list[DeckSummary])
def list_decks(
    cfg: AzureConfig = Depends(get_cfg),
    principal: Principal = Depends(get_principal),
) -> list[DeckSummary]:
    """Admins see every deck; anonymous callers only published ones.

    ``[]`` means no deck is published (or Cosmos DB is not configured at all). A
    Cosmos DB that is configured but failing answers 503 — never an empty list."""
    store = _store(cfg)
    if not store:
        if cfg.cosmos_endpoint:
            raise _library_unavailable()
        return []
    try:
        docs = store.list_decks(strict=True)
    except StorageUnavailable:
        raise _library_unavailable()
    except Exception:
        log.exception("list_decks failed")
        raise _library_unavailable()
    out: list[DeckSummary] = []
    for d in docs:
        if not isinstance(d, dict) or not d.get("id"):
            continue
        if not principal.is_admin and d.get("published") is not True:
            continue
        out.append(_doc_to_summary(d))
    return out


@public_router.get("/decks/{deck_id}", response_model=None)
def get_deck(
    deck_id: str,
    cfg: AzureConfig = Depends(get_cfg),
    principal: Principal = Depends(get_principal),
) -> DeckDetail | PublicDeckDetail:
    """Full deck for admins; titles, slide images and slide text only for anonymous callers.

    Two distinct response models keep the anonymous payload free of body,
    notes and translated notes (not just empty values). Anonymous slides carry
    ``text`` (the visible body, capped) and the deck's ``filename`` is its
    display title. 404 means the deck does not exist (or is not published); a
    storage failure answers 503, never 404."""
    require_id(deck_id, UUID_RE, "Deck")
    store = _store(cfg)
    if not store or not store.cosmos_available:
        raise _library_unavailable()
    try:
        doc = store.get_presentation(deck_id, strict=True)
    except StorageUnavailable:
        raise _library_unavailable()
    except Exception:
        log.exception("get_presentation failed for deck %s", deck_id)
        raise _library_unavailable()
    if not doc or doc.get("source") != "deck":
        raise HTTPException(status_code=404, detail="Deck not found")
    public = not principal.is_admin
    if public and doc.get("published") is not True:
        raise HTTPException(status_code=404, detail="Deck not found")

    blob_ok = bool(store.available)
    # Bumped by `maintenance.content rebrand-decks` when slide PNGs are overwritten in place;
    # signed blob URLs already differ per request, stable local URLs get `?v=`.
    version = int(doc.get("images_version") or 0)

    def _bust(url: str) -> str:
        return f"{url}?v={version}" if version and "?" not in url else url

    def _image_url(s: dict, i: int) -> str:
        idx = int(s.get("index", i))
        if blob_ok:
            minutes = PUBLIC_SAS_MINUTES if public else 24 * 60
            try:
                url = store.get_slide_image_url(deck_id, idx, expiry_minutes=minutes)
            except Exception:
                url = None
            if url:
                return _bust(url)
        if public:
            return _bust(f"/api/slides/{deck_id}/{idx}.png")
        return _bust(s.get("image_url") or f"/api/slides/{deck_id}/{idx}.png")

    raw_slides = [(i, s) for i, s in enumerate(doc.get("slides") or []) if isinstance(s, dict)]
    summary = _doc_to_summary(doc)
    if public:
        return PublicDeckDetail(
            **summary.model_dump(),
            id=deck_id,
            filename=summary.title,
            slides=[
                PublicSlidePayload(
                    index=int(s.get("index", i)),
                    title=s.get("title") or f"Slide {i + 1}",
                    image_url=_image_url(s, i),
                    text=_slide_text(s),
                )
                for i, s in raw_slides
            ],
        )
    slides = [
        SlidePayload(
            index=int(s.get("index", i)),
            title=s.get("title") or f"Slide {i + 1}",
            body=s.get("body") or "",
            notes=s.get("notes") or "",
            translated_notes=_cached_translations(s),
            image_url=_image_url(s, i),
        )
        for i, s in raw_slides
    ]
    return DeckDetail(
        **summary.model_dump(),
        id=deck_id,
        filename=doc.get("filename") or deck_id,
        slides=slides,
    )


_TRANSLATE_CONCURRENCY = 4


@router.post("/decks/{deck_id}/translate-notes", response_model=TranslateDeckNotesResponse)
async def translate_deck_notes(
    deck_id: str,
    req: TranslateDeckNotesRequest,
    cfg: AzureConfig = Depends(get_cfg),
    principal: Principal = Depends(require_admin),
) -> TranslateDeckNotesResponse:
    """Admin: translate a catalog deck's speaker notes into one language.

    Mirrors ``/api/presentations/{id}/translate-notes`` (same translator, same
    ``slides[].translated_notes[lang]`` cache in Cosmos) so the Decks present
    page narrates in the selected language. Already-cached languages return
    instantly without consuming quota."""
    return await translate_deck_notes_for(
        deck_id, req.target_language, cfg, charge=lambda: DAILY_QUOTA.consume(principal.user_id),
    )


async def translate_deck_notes_for(
    deck_id: str, lang: str, cfg: AzureConfig, *, charge: Optional[Callable[[], None]] = None,
) -> TranslateDeckNotesResponse:
    """Translate + cache one deck's notes; ``charge`` runs only when work is needed.

    Shared by the admin route and the operator maintenance CLI."""
    require_id(deck_id, UUID_RE, "Deck")
    store = _store(cfg)
    if not store or not store.cosmos_available:
        raise HTTPException(status_code=503, detail="Storage unavailable")
    doc = store.get_presentation(deck_id)
    if not doc or doc.get("source") != "deck":
        raise HTTPException(status_code=404, detail="Deck not found")

    result: dict[str, str] = {}
    pending: list[tuple[int, str]] = []
    for i, s in enumerate(doc.get("slides") or []):
        if not isinstance(s, dict):
            continue
        notes = s.get("notes") or ""
        if not notes.strip():
            continue
        idx = int(s.get("index", i))
        cached = _cached_translations(s).get(lang)
        if cached:
            result[str(idx)] = cached
        else:
            pending.append((idx, notes))

    if not pending:
        return TranslateDeckNotesResponse(deck_id=deck_id, target_language=lang, translated_notes=result, cached=True)

    if not cfg.openai_endpoint:
        raise HTTPException(status_code=503, detail="Translation service not configured")
    if charge is not None:
        charge()
    client = get_openai_client(cfg)
    sem = asyncio.Semaphore(_TRANSLATE_CONCURRENCY)

    async def _one(idx: int, text: str) -> tuple[int, str]:
        async with sem:
            out = await asyncio.to_thread(translate_text, client, text, lang, cfg.openai_chat_deployment)
            return idx, out

    try:
        fresh = dict(await asyncio.gather(*[_one(idx, text) for idx, text in pending]))
    except Exception:
        log.exception("Translating notes of deck %s to %s failed", deck_id, lang)
        raise HTTPException(status_code=502, detail="Translation failed")
    fresh = {k: v for k, v in fresh.items() if v and v.strip()}

    # Re-read before writing so a concurrent publish/live-demo toggle is not lost.
    latest = store.get_presentation(deck_id) or doc
    for i, s in enumerate(latest.get("slides") or []):
        if not isinstance(s, dict):
            continue
        idx = int(s.get("index", i))
        if idx in fresh:
            tn = s.get("translated_notes") if isinstance(s.get("translated_notes"), dict) else {}
            tn[lang] = fresh[idx]
            s["translated_notes"] = tn
    try:
        store.save_presentation(latest)
    except Exception:
        log.exception("Could not cache translated notes for deck %s", deck_id)
    result.update({str(k): v for k, v in fresh.items()})
    return TranslateDeckNotesResponse(deck_id=deck_id, target_language=lang, translated_notes=result, cached=False)


@router.post("/decks/{deck_id}/publish", response_model=DeckSummary)
def publish_deck(deck_id: str, body: PublishRequest, cfg: AzureConfig = Depends(get_cfg)) -> DeckSummary:
    """Admin: show/hide a deck to anonymous viewers."""
    require_id(deck_id, UUID_RE, "Deck")
    store = _store(cfg)
    if not store or not store.cosmos_available:
        raise HTTPException(status_code=503, detail="Storage unavailable")
    doc = store.set_deck_published(deck_id, body.published)
    if not doc:
        raise HTTPException(status_code=404, detail="Deck not found")
    return _doc_to_summary(doc)


@router.post("/decks/{deck_id}/live-demo", response_model=DeckSummary)
def set_live_demo(deck_id: str, body: LiveDemoRequest, cfg: AzureConfig = Depends(get_cfg)) -> DeckSummary:
    """Admin: allow (or stop) anonymous visitors running the live avatar demo
    on this deck. Only published decks can be live demos."""
    require_id(deck_id, UUID_RE, "Deck")
    store = _store(cfg)
    if not store or not store.cosmos_available:
        raise HTTPException(status_code=503, detail="Storage unavailable")
    current = store.get_presentation(deck_id)
    if not current or current.get("source") != "deck":
        raise HTTPException(status_code=404, detail="Deck not found")
    if body.enabled and current.get("published") is not True:
        raise HTTPException(status_code=409, detail="Publish the deck before enabling the live demo")
    try:
        doc = store.set_deck_live_demo(deck_id, body.enabled)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    if not doc:
        raise HTTPException(status_code=404, detail="Deck not found")
    return _doc_to_summary(doc)


@router.delete("/decks/{deck_id}")
def delete_deck(deck_id: str, force: bool = False, cfg: AzureConfig = Depends(get_cfg)) -> dict:
    require_id(deck_id, UUID_RE, "Deck")
    store = _store(cfg)
    broken_playlists: list[str] = []
    if store and store.cosmos_available:
        refs = store.playlists_referencing_deck(deck_id)
        if refs and not force:
            titles = ", ".join(p.get("title", p.get("id", "")) for p in refs)
            raise HTTPException(
                status_code=409,
                detail=f"Deck is referenced by {len(refs)} playlist(s): {titles}. Use ?force=true to delete and break those playlists.",
            )
        # force=true → mark each referencing playlist as broken
        for p in refs:
            p["status"] = "broken"
            p["updated_at"] = datetime.now(timezone.utc).isoformat()
            try:
                store.save_playlist(p)
                broken_playlists.append(p["id"])
            except Exception:
                log.exception("Failed to mark playlist %s broken", p.get("id"))

    if store:
        try:
            store.delete_presentation(deck_id)
        except Exception:
            log.exception("Cosmos delete failed for %s", deck_id)
        try:
            store.delete_slide_images(deck_id)
        except Exception:
            log.exception("Blob delete failed for %s", deck_id)

    removed = 0
    try:
        openai_client = get_openai_client(cfg)
        search = get_deck_search(cfg, openai_client)
        if search:
            removed = search.delete_deck(deck_id)
    except Exception:
        log.exception("Search delete failed for %s", deck_id)

    return {"deck_id": deck_id, "removed_chunks": removed, "broken_playlists": broken_playlists}


@router.post("/search", response_model=SearchResponse)
def search_decks(
    req: SearchRequest,
    cfg: AzureConfig = Depends(get_cfg),
    principal: Principal = Depends(require_admin),
) -> SearchResponse:
    if not req.query or not req.query.strip():
        raise HTTPException(status_code=400, detail="Empty query")
    DAILY_QUOTA.consume(principal.user_id)
    openai_client = get_openai_client(cfg)
    search = get_deck_search(cfg, openai_client)
    if not search:
        raise HTTPException(status_code=503, detail="Search not configured")
    top_k = max(1, min(20, req.top_k))
    try:
        hits = search.search(req.query, top_k=top_k, language=req.language)
    except Exception:
        log.exception("Deck search failed")
        raise HTTPException(status_code=500, detail="Search failed")
    return SearchResponse(
        results=[
            SearchResultItem(
                deck_id=h.deck_id,
                deck_title=h.deck_title,
                slide_index=h.slide_index,
                slide_title=h.slide_title,
                snippet=h.snippet,
                score=h.score,
            )
            for h in hits
        ]
    )
