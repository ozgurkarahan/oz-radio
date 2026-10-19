"""Oz Radio content maintenance CLI (operator job, runs inside the app container).

Seeds the AI enablement catalog, renders podcasts/videos for it and purges
retired content, reusing the routers' own code paths (catalog upload,
publish, translate-notes, live demo, playlists, podcast/video render workers
and library deletes) with the app's managed identity. Nothing goes through
HTTP or Easy Auth, so no principal is created or impersonated; the per-user
daily request quota (an HTTP-layer limit) is not consumed by these jobs.

Usage (from the backend directory, ``/app`` in the image)::

    python -m maintenance.content inventory [--json out.json]
    python -m maintenance.content seed [--dry-run]
    python -m maintenance.content script-podcast {beginner,practitioner,expert,demo-fr} --out script.json \\
        [--dry-run]
    python -m maintenance.content script-video {demo-en,demo-fr,practitioner} --out script.json [--dry-run]
    python -m maintenance.content render-podcast {beginner,practitioner,expert,demo-fr,all} \\
        [--format video|audio] [--force] [--unpublished] [--from-script script.json] [--dry-run]
    python -m maintenance.content render-video {demo-en,demo-fr,practitioner,all} \\
        [--force] [--unpublished] [--from-script script.json] [--dry-run]
    python -m maintenance.content warm-listeners [--language en-US --language fr-FR] [--timeout 900] [--dry-run]
    python -m maintenance.content publish [--podcast-id job-...] [--video-id sv-...] [--off] [--dry-run]
    python -m maintenance.content unpublish [--podcast-id job-...] [--video-id sv-...] [--dry-run]
    python -m maintenance.content plan-switch --out switch.json [--dry-run]
    python -m maintenance.content switch --manifest switch.json [--dry-run]
    python -m maintenance.content rollback --manifest switch.json [--dry-run]
    python -m maintenance.content purge --deck-title T ... --podcast-id job-... --video-id sv-... \\
        --record deleted.json [--allow-missing video:practitioner] [--dry-run]
    python -m maintenance.content retitle [--dry-run]
    python -m maintenance.content rebrand-decks [--deck ai-enablement-1-beginner ...] [--dry-run]
    python -m maintenance.content --background /tmp/all.log all [--skip video:practitioner]
    python -m maintenance.content logtail /tmp/all.log -n 40

``--background LOG`` detaches the job (new session) so a short
``az containerapp exec`` call can start a long render; ``logtail`` prints the
log with URL query strings redacted.

Every command is idempotent: decks are matched by title, the playlist by name,
videos by library title and podcasts by library title and format (an existing
item is only published).
Titles match either the display title (``DISPLAY_TITLES``) or the original
filename slug, so content seeded before ``retitle`` is never duplicated.
Output never contains signed URLs.

``render-podcast --format`` picks the rendition: ``video`` (MP4 + radio MP3,
the default of every ``PODCASTS`` spec) or ``audio`` (radio MP3 only, no
avatar synthesis). Renders ask for listener backchannels; they are only
rendered when the ``PODCAST_REACTIONS`` kill switch is on.

``render-podcast``/``render-video --force`` render a fresh item even when one
with the same title exists (e.g. after a rebrand) and publish it at once;
``purge --podcast-id/--video-id`` deletes a superseded item (media only: purge
touches playlists only when ``--deck-title`` deletes decks).

Staged re-render (no gap, no duplicate for visitors, nothing is deleted):

1. ``script-podcast|script-video NAME --out FILE`` runs the render's own ingest
   and script generation (same spec inputs, same prompts) and stops there: no
   render, no library access, nothing published. It writes the script as JSON
   (``kind``, ``key``, ``title``, ``language``, ``audience_level``, the model's
   ``turns`` or ``narrations`` as the render consumes them, ``generated_at``, the
   deck's SHA-256 and a ``content_sha256`` of the lines), prints a compact
   transcript (a character the console cannot encode becomes a backslash escape
   instead of an error) and one ``SCRIPTED <kind> <name> <sha256> <file>`` line.
   It costs one model call, so a short exec is enough (``--background LOG``
   works as everywhere). It never overwrites a file; ``--dry-run`` makes no
   model call and writes nothing.
2. Review the transcripts: nothing has been rendered or paid for yet.
3. ``render-podcast|render-video NAME --from-script FILE`` renders exactly that
   text and skips script generation (one episode, not ``all``). The file is
   validated first, before any ingest, model call or library access: size cap,
   JSON, exact schema, same kind and key, the spec's language, style, audience
   (and voice), the deck unchanged since the script was written, ``content_sha256``
   matching the lines (a file edited after generation is refused: generate it
   again) and the routers' own limits. It prints
   ``USING_SCRIPT <kind> <name> <sha256> <file>``, the digest the review saw.
4. ``render-podcast|render-video ... --force --unpublished`` archives the new
   item with ``published: false`` and never publishes it. Each render prints one
   machine-readable line, ``RENDERED <podcast|video> <name> <job id>`` (no URLs),
   as soon as it is archived. Without ``--force``, an existing item with the
   title is only reported: ``--unpublished`` never publishes anything.
5. Review the private renders as an admin (the library lists them).
6. ``plan-switch --out switch.json`` pairs every published item with its newer
   unpublished re-render (same title, format and language) and writes the
   manifest, ``{"pairs": [{"kind": "podcast"|"video", "old_id": "job-...",
   "new_id": "job-..."}]}`` (a hand-written file needs only those keys). Matches
   it cannot decide (several published items, or several newer private
   re-renders, for one title) are left out and reported, never guessed; exit
   code 1 then flags the incomplete plan. It never overwrites a file.
7. ``switch --manifest switch.json`` publishes each new item, then unpublishes
   its old one (never a gap), pair by pair, and stops at the first failure.
   ``rollback --manifest switch.json`` publishes each old item, then unpublishes
   the new one. Both refuse a manifest whose items are missing or whose old and
   new titles, formats or languages differ (before changing anything), are
   idempotent (a step already in its target state is ``already``) and append one
   ``log`` entry per step (``at``, ``command``, ``step``, ``id``, ``outcome``) to
   the pair in the manifest file, with ``status`` kept current (``switching``,
   ``switched``, ``switch_failed``, ``rolling_back``, ``rolled_back``,
   ``rollback_failed``). A failed step changes nothing further (a failed
   ``unpublish_old`` leaves both items visible, never neither); re-run the
   command or roll back. ``--dry-run`` reads the library but writes nothing,
   not even the manifest.
8. ``publish``/``unpublish`` change single items by id (``--podcast-id``,
   ``--video-id``; both repeatable); an unpublished item is hidden, not deleted.

``warm-listeners`` pre-builds the cached listener kits (silent listening loop
and backchannel clips; one paid batch avatar job per missing kit) of the
showcase cast in every ``VOICES`` language, so the first video render does
not wait for them. It prints avatar ids, voices, modes and warning codes only.

``rebrand-decks`` re-renders the AI decks from the regenerated .pptx and
overwrites the slide images, slide text and search chunks of the *same*
deck ids in place (speaker notes must be identical; titles, translated
notes, published/live-demo flags and playlists are kept).
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import io
import json
import logging
import math
import os
import shutil
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, Sequence

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

log = logging.getLogger("maintenance.content")

# Decks ship in the image at maintenance/decks/ (Dockerfile); locally they are
# read from the repository's content/ai-enablement/.
DECK_DIRS = (
    Path(__file__).resolve().parent / "decks",
    BACKEND_DIR.parent.parent / "content" / "ai-enablement",
)

INTERVIEWER = ("Sofia", "photo_female", "female")
EXPERT = ("Lucas", "photo_male", "male")

# language -> gender -> HD voice (must be in services.voice_catalog)
VOICES = {
    "en-US": {"female": "en-US-Ava:DragonHDLatestNeural", "male": "en-US-Andrew:DragonHDLatestNeural"},
    "fr-FR": {"female": "fr-FR-Vivienne:DragonHDLatestNeural", "male": "fr-FR-Remy:DragonHDLatestNeural"},
}


# Filename slug -> human-readable display title (decks, podcasts and videos).
DISPLAY_TITLES: dict[str, str] = {
    "ai-enablement-1-beginner": "AI, demystified · Beginner",
    "ai-enablement-2-practitioner": "Building with AI · Practitioner",
    "ai-enablement-3-expert": "Under the hood · Expert",
    "ai-enablement-demo-beginner": "AI in three minutes · Live demo",
    "ai-enablement-demo-beginner-fr": "L’IA en trois minutes · Démo en direct",
}


def display_title(slug: str) -> str:
    return DISPLAY_TITLES.get(slug, slug)


class _Titled:
    """Mixin: ``slug`` (file stem), ``title`` (display) and both as ``titles``."""

    _source: str

    @property
    def slug(self) -> str:
        return Path(self._source).stem

    @property
    def title(self) -> str:
        return display_title(self.slug)

    @property
    def titles(self) -> frozenset[str]:
        return frozenset({self.slug, self.title})


@dataclass(frozen=True)
class DeckSeed(_Titled):
    file: str
    language: str
    live_demo: bool = False
    translate_to: tuple[str, ...] = ()

    @property
    def _source(self) -> str:  # type: ignore[override]
        return self.file


SEED_DECKS: tuple[DeckSeed, ...] = (
    DeckSeed("ai-enablement-1-beginner.pptx", "en-US", translate_to=("fr-FR",)),
    DeckSeed("ai-enablement-2-practitioner.pptx", "en-US", translate_to=("fr-FR",)),
    DeckSeed("ai-enablement-3-expert.pptx", "en-US", translate_to=("fr-FR",)),
    DeckSeed("ai-enablement-demo-beginner.pptx", "en-US", live_demo=True, translate_to=("fr-FR",)),
    DeckSeed("ai-enablement-demo-beginner-fr.pptx", "fr-FR", live_demo=True, translate_to=("en-US",)),
)

PLAYLIST_TITLE = "AI enablement path"
PLAYLIST_DESCRIPTION = (
    "From first principles to production internals: AI, Demystified (Beginner), "
    "Building with AI (Practitioner), then Under the Hood (Expert)."
)
PLAYLIST_STEPS = (
    "ai-enablement-1-beginner",
    "ai-enablement-2-practitioner",
    "ai-enablement-3-expert",
)


PODCAST_FORMATS = ("video", "audio")


@dataclass(frozen=True)
class PodcastSpec(_Titled):
    deck: str
    language: str
    style: str
    audience_level: str
    length: str = "medium"
    num_turns: int = 8
    # "video" = MP4 + radio MP3 (Watch and Listen); "audio" = radio MP3 only.
    format: str = "video"

    @property
    def _source(self) -> str:  # type: ignore[override]
        return self.deck


PODCASTS: dict[str, PodcastSpec] = {
    "beginner": PodcastSpec("ai-enablement-1-beginner.pptx", "en-US", "explainer", "beginner"),
    "practitioner": PodcastSpec("ai-enablement-2-practitioner.pptx", "en-US", "casual", "practitioner"),
    "expert": PodcastSpec("ai-enablement-3-expert.pptx", "en-US", "debate", "expert"),
    "demo-fr": PodcastSpec("ai-enablement-demo-beginner-fr.pptx", "fr-FR", "casual", "beginner"),
}


@dataclass(frozen=True)
class VideoSpec(_Titled):
    deck: str
    language: str
    avatar: str
    gender: str
    audience_level: str
    style: str = "explainer"

    @property
    def _source(self) -> str:  # type: ignore[override]
        return self.deck

    @property
    def voice(self) -> str:
        return VOICES[self.language][self.gender]


VIDEOS: dict[str, VideoSpec] = {
    "demo-en": VideoSpec("ai-enablement-demo-beginner.pptx", "en-US", "photo_female", "female", "beginner"),
    "demo-fr": VideoSpec("ai-enablement-demo-beginner-fr.pptx", "fr-FR", "photo_male", "male", "beginner"),
    "practitioner": VideoSpec("ai-enablement-2-practitioner.pptx", "en-US", "photo_female", "female",
                              "practitioner"),
}


class MaintenanceError(RuntimeError):
    pass


def _say(msg: str) -> None:
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}", flush=True)


def _cfg():
    from config import load_config

    return load_config()


def _deck_path(name: str, deck_dir: Optional[Path] = None) -> Path:
    dirs = (Path(deck_dir),) if deck_dir else DECK_DIRS
    for d in dirs:
        p = d / name
        if p.is_file():
            return p
    raise MaintenanceError(f"deck file {name} not found in {[str(d) for d in dirs]}")


def _staged_copy(src: Path, kind: str) -> Path:
    """Copy a deck under data/uploads/<kind>/ like the upload routes do."""
    tmp_dir = Path("data/uploads") / kind
    tmp_dir.mkdir(parents=True, exist_ok=True)
    dst = tmp_dir / f"{uuid.uuid4().hex}{src.suffix.lower()}"
    shutil.copyfile(src, dst)
    return dst


def _strip_urls(item: dict) -> dict:
    return {k: v for k, v in item.items() if not k.endswith("_url")}


# ---------------------------------------------------------------------------
# Inventory
# ---------------------------------------------------------------------------
def inventory(cfg) -> dict[str, Any]:
    from routers import decks as dr
    from routers import podcast as pr
    from routers import video as vr

    out: dict[str, Any] = {"captured_at": datetime.now(timezone.utc).isoformat()}
    store = dr._store(cfg)
    if not store or not store.cosmos_available:
        raise MaintenanceError("Cosmos DB unavailable")
    out["decks"] = [dr._doc_to_summary(d).model_dump() for d in store.list_decks()
                    if isinstance(d, dict) and d.get("id")]
    out["playlists"] = [
        {"id": p.get("id"), "title": p.get("title"), "status": p.get("status", "active"),
         "steps": [{"deck_id": s.get("deck_id"), "deck_title": s.get("deck_title"), "order": s.get("order")}
                   for s in sorted(p.get("steps") or [], key=lambda s: s.get("order", 0))]}
        for p in store.list_playlists()
    ]
    plib, vlib = pr._get_library(cfg), vr._get_library(cfg)
    out["podcasts"] = [_strip_urls(i) for i in plib.list()] if plib.available else []
    out["videos"] = [_strip_urls(i) for i in vlib.list()] if vlib.available else []
    return out


# ---------------------------------------------------------------------------
# Seed decks + playlist
# ---------------------------------------------------------------------------
async def seed(cfg, *, dry_run: bool = False, deck_dir: Optional[Path] = None) -> dict[str, Any]:
    from routers import decks as dr
    from routers import playlists as plr

    store = dr._store(cfg)
    if not store or not store.cosmos_available:
        raise MaintenanceError("Cosmos DB unavailable")
    by_title: dict[str, dict] = {}
    for d in store.list_decks():
        if isinstance(d, dict) and d.get("id"):
            by_title.setdefault(dr._doc_to_summary(d).title, d)

    report: dict[str, Any] = {"decks": [], "playlist": None, "dry_run": dry_run}
    ids: dict[str, Optional[str]] = {}
    for spec in SEED_DECKS:
        path = _deck_path(spec.file, deck_dir)
        entry: dict[str, Any] = {"title": spec.title, "language": spec.language}
        doc = by_title.get(spec.title) or by_title.get(spec.slug)
        if doc:
            deck_id = doc["id"]
            entry["action"] = "exists"
            if (doc.get("language") or "en-US") != spec.language:
                entry["warning"] = f"existing deck language is {doc.get('language')}"
        elif dry_run:
            deck_id = None
            entry["action"] = "would upload"
        else:
            content = path.read_bytes()
            if content[:4] != b"PK\x03\x04":
                raise MaintenanceError(f"{path} is not a .pptx")
            _say(f"upload {spec.file} ({spec.language})")
            resp = await asyncio.to_thread(dr.ingest_deck_bytes, content, spec.file, spec.language, cfg,
                                           title=spec.title)
            deck_id = resp.deck_id
            entry.update(action="uploaded", slide_count=resp.slide_count, indexed_slides=resp.indexed_slides)
        entry["deck_id"] = deck_id
        ids[spec.slug] = deck_id

        if deck_id and not dry_run:
            current = store.get_presentation(deck_id) or {}
            if current.get("published") is not True:
                dr.publish_deck(deck_id, dr.PublishRequest(published=True), cfg=cfg)
                entry["published"] = "now"
            else:
                entry["published"] = "already"
            for lang in spec.translate_to:
                tr = await dr.translate_deck_notes_for(deck_id, lang, cfg)
                entry.setdefault("translated", {})[lang] = "cached" if tr.cached else f"{len(tr.translated_notes)} slides"
            if spec.live_demo:
                current = store.get_presentation(deck_id) or {}
                if current.get("live_demo") is not True:
                    dr.set_live_demo(deck_id, dr.LiveDemoRequest(enabled=True), cfg=cfg)
                    entry["live_demo"] = "now"
                else:
                    entry["live_demo"] = "already"
        _say(f"deck {spec.title}: {entry['action']}")
        report["decks"].append(entry)

    existing = [p for p in store.list_playlists()
                if p.get("title") == PLAYLIST_TITLE and p.get("status", "active") != "broken"]
    if existing:
        report["playlist"] = {"id": existing[0].get("id"), "action": "exists"}
    elif dry_run or any(not ids.get(t) for t in PLAYLIST_STEPS):
        report["playlist"] = {"action": "would create", "steps": list(PLAYLIST_STEPS)}
    else:
        body = plr.PlaylistCreate(
            title=PLAYLIST_TITLE,
            description=PLAYLIST_DESCRIPTION,
            steps=[plr.PlaylistStepIn(deck_id=ids[t], order=i) for i, t in enumerate(PLAYLIST_STEPS)],
        )
        created = plr.create_playlist(body, cfg=cfg)
        report["playlist"] = {"id": created.id, "action": "created",
                              "steps": [s.deck_title for s in created.steps]}
    _say(f"playlist {PLAYLIST_TITLE!r}: {report['playlist']['action']}")
    return report


# ---------------------------------------------------------------------------
# Reviewed scripts: script-podcast / script-video write one, render --from-script renders it
# ---------------------------------------------------------------------------
SCRIPT_SCHEMA_VERSION = 1
# A script is 10-150 KB (at most 40 turns or 60 narrations of 3,000 characters): anything bigger is not ours.
MAX_SCRIPT_FILE_BYTES = 1024 * 1024
SCRIPT_ITEMS = {"podcast": "turns", "video": "narrations"}  # where each kind keeps its lines
_SCRIPT_HEADER = ("schema_version", "kind", "key", "title", "deck", "deck_sha256", "language", "style",
                  "audience_level", "generated_at", "content_sha256")
SCRIPT_KEYS = {  # the exact top-level keys of a script file
    "podcast": frozenset({*_SCRIPT_HEADER, "turns"}),
    "video": frozenset({*_SCRIPT_HEADER, "voice", "narrations"}),
}
SCRIPT_LINE_KEYS = {  # the exact keys of one line
    "podcast": frozenset({"idx", "speaker", "text", "slide_idx", "reaction"}),
    "video": frozenset({"slide_index", "narration", "speaking_style", "duration_hint_s"}),
}


def _out(line: str) -> None:
    """Print one line; a character the console cannot encode becomes a backslash escape, never an error."""
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        print(line.encode("ascii", "backslashreplace").decode("ascii"), flush=True)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _script_digest(lines: Any) -> str:
    """SHA-256 of a script's lines as canonical JSON: ties the transcript that was reviewed to the file rendered."""
    return hashlib.sha256(json.dumps(lines, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _spec_inputs(kind: str, spec) -> dict[str, Any]:
    """The spec inputs that shape a script's text: a file generated for other ones is refused."""
    inputs = {"deck": spec.deck, "language": spec.language, "style": spec.style,
              "audience_level": spec.audience_level}
    if kind == "video":
        inputs["voice"] = spec.voice
    return inputs


def _router_limits(check, items) -> None:
    """Run one of the routers' own limit checks (they raise HTTPException) as a MaintenanceError."""
    from fastapi import HTTPException

    try:
        check(items)
    except HTTPException as exc:
        raise MaintenanceError(str(exc.detail)) from None


def _check_narrations(narrations) -> None:
    """The video router's render limits (routers.video.start_render), for scripts built outside it."""
    from security import MAX_NARRATION_CHARS, MAX_SLIDES_PER_RENDER
    from services.voice_catalog import is_allowed_voice

    if len(narrations) > MAX_SLIDES_PER_RENDER:
        raise MaintenanceError(f"too many slides (max {MAX_SLIDES_PER_RENDER})")
    for n in narrations:
        if len(n.narration or "") > MAX_NARRATION_CHARS or (n.voice and not is_allowed_voice(n.voice)):
            raise MaintenanceError(f"slide {n.slide_index}: narration too long or voice not allowed")


def _podcast_lines(turns) -> list[dict[str, Any]]:
    """The turns as stored in a script file: only what the model wrote (timings are render output)."""
    return [{"idx": t.idx, "speaker": t.speaker, "text": t.text, "slide_idx": t.slide_idx,
             "reaction": t.reaction.model_dump() if t.reaction else None} for t in turns]


def _video_lines(narrations) -> list[dict[str, Any]]:
    """The narrations as stored (sorted as the render consumes them); slide images and titles are not stored."""
    return [{"slide_index": n.slide_index, "narration": n.narration, "speaking_style": n.speaking_style,
             "duration_hint_s": n.duration_hint_s} for n in sorted(narrations, key=lambda n: n.slide_index)]


def _podcast_turns_from(lines: list[dict[str, Any]]) -> list:
    from services.podcast_models import DialogueTurn, ReactionHint

    return [DialogueTurn(idx=line["idx"], speaker=line["speaker"], text=line["text"], slide_idx=line["slide_idx"],
                         reaction=ReactionHint(**line["reaction"]) if line["reaction"] else None)
            for line in lines]


def _video_narrations_from(lines: list[dict[str, Any]], spec: VideoSpec, doc=None) -> list:
    """The lines as the render consumes them. Slide images and titles come from ``doc``, the freshly
    ingested deck (the paths of the ingest that generated the script are gone); without it they stay empty."""
    from services.video_models import SlideNarration

    refs = {s.index: s for s in doc.slides} if doc is not None else None
    if refs is not None:
        absent = sorted(line["slide_index"] for line in lines if line["slide_index"] not in refs)
        if absent:
            raise MaintenanceError(f"the deck has no slide {absent}: generate the script again")
    return [SlideNarration(
        slide_index=line["slide_index"],
        slide_image_ref=refs[line["slide_index"]].image_ref if refs else "",
        title=refs[line["slide_index"]].title if refs else None,
        narration=line["narration"], voice=spec.voice, speaking_style=line["speaking_style"],
        duration_hint_s=line["duration_hint_s"]) for line in lines]


def _valid_reaction(raw: Any) -> bool:
    from pydantic import ValidationError
    from services.podcast_models import ReactionHint

    if not isinstance(raw, dict) or set(raw) != {"after_sentence", "reaction_id"}:
        return False
    try:
        ReactionHint(**raw)
    except ValidationError:
        return False
    return True


def _script_line_problems(kind: str, lines: Any) -> list[str]:
    """What is wrong with a script's lines (empty = well-formed): exact keys, types, unique ids."""
    what = SCRIPT_ITEMS[kind]
    if not isinstance(lines, list) or not lines:
        return [f"{what} must be a non-empty list"]
    id_key, text_key = ("idx", "text") if kind == "podcast" else ("slide_index", "narration")
    problems: list[str] = []
    seen: set[int] = set()
    for n, line in enumerate(lines):
        where = f"{what}[{n}]"
        if not isinstance(line, dict) or set(line) != SCRIPT_LINE_KEYS[kind]:
            problems.append(f"{where} must have exactly the keys {sorted(SCRIPT_LINE_KEYS[kind])}")
            continue
        if not _is_int(line[id_key]) or line[id_key] < 0:
            problems.append(f"{where}.{id_key} must be a non-negative integer")
        elif line[id_key] in seen:
            problems.append(f"{where}.{id_key} {line[id_key]} appears twice")
        else:
            seen.add(line[id_key])
        if not isinstance(line[text_key], str) or not line[text_key].strip():
            problems.append(f"{where}.{text_key} must be non-empty text")
        if kind == "podcast":
            if line["speaker"] not in ("interviewer", "expert"):
                problems.append(f"{where}.speaker must be 'interviewer' or 'expert'")
            if line["slide_idx"] is not None and not _is_int(line["slide_idx"]):
                problems.append(f"{where}.slide_idx must be an integer or null")
            if line["reaction"] is not None and not _valid_reaction(line["reaction"]):
                problems.append(f"{where}.reaction must be null or a known {{after_sentence, reaction_id}}")
        else:
            style, seconds = line["speaking_style"], line["duration_hint_s"]
            if style is not None and not isinstance(style, str):
                problems.append(f"{where}.speaking_style must be text or null")
            if seconds is not None and (isinstance(seconds, bool) or not isinstance(seconds, (int, float))
                                        or not math.isfinite(seconds) or seconds < 0):
                problems.append(f"{where}.duration_hint_s must be a non-negative number or null")
    return problems


def _script_limit_problems(kind: str, lines: list[dict[str, Any]], spec) -> list[str]:
    """The routers' own render limits, applied to a script that did not come through them."""
    try:
        if kind == "podcast":
            from routers import podcast as pr

            _router_limits(pr._check_turns, _podcast_turns_from(lines))
        else:
            _check_narrations(_video_narrations_from(lines, spec))
    except MaintenanceError as exc:
        return [str(exc)]
    return []


@dataclass(frozen=True)
class LoadedScript:
    """A validated script file: the lines ``render --from-script`` renders, and what it reports about them."""

    path: Path
    kind: str
    key: str
    lines: list
    content_sha256: str
    generated_at: str

    def summary(self) -> dict[str, Any]:
        return {"file": str(self.path), SCRIPT_ITEMS[self.kind]: len(self.lines),
                "content_sha256": self.content_sha256, "generated_at": self.generated_at}


def _read_script_json(path: Path) -> dict[str, Any]:
    try:
        size = path.stat().st_size
        if size > MAX_SCRIPT_FILE_BYTES:
            raise MaintenanceError(f"script file {path} is {size} bytes: over the {MAX_SCRIPT_FILE_BYTES} byte cap")
        with path.open("rb") as fh:
            raw = fh.read(MAX_SCRIPT_FILE_BYTES + 1)
    except OSError as exc:
        raise MaintenanceError(f"cannot read script file {path}: {exc.strerror or type(exc).__name__}") from None
    if len(raw) > MAX_SCRIPT_FILE_BYTES:
        raise MaintenanceError(f"script file {path} is over the {MAX_SCRIPT_FILE_BYTES} byte cap")
    try:
        data = json.loads(raw.decode("utf-8-sig"))
    except (ValueError, RecursionError) as exc:  # includes UnicodeDecodeError and JSONDecodeError
        raise MaintenanceError(f"script file {path} is not valid JSON: {type(exc).__name__}") from None
    if not isinstance(data, dict):
        raise MaintenanceError(f"script file {path} must be a JSON object")
    return data


def _is_timestamp(value: Any) -> bool:
    try:
        datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return False
    return True


def _load_script(path: Path, kind: str, name: str, spec, deck_path: Path) -> LoadedScript:
    """Read and validate a script file for ``kind``/``name`` before any ingest, model call or library access."""
    data = _read_script_json(path)
    problems: list[str] = []
    missing, unknown = sorted(SCRIPT_KEYS[kind] - set(data)), sorted(set(data) - SCRIPT_KEYS[kind])
    if missing:
        problems.append(f"missing keys {missing}")
    if unknown:
        problems.append(f"unexpected keys {unknown}")
    expected = {"schema_version": SCRIPT_SCHEMA_VERSION, "kind": kind, "key": name, **_spec_inputs(kind, spec)}
    problems += [f"{field} is {repr(data[field])[:60]}, expected {want!r}"
                 for field, want in expected.items() if field in data and data[field] != want]
    if "generated_at" in data and not _is_timestamp(data["generated_at"]):
        problems.append("generated_at must be an ISO timestamp")
    lines = data.get(SCRIPT_ITEMS[kind])
    problems += _script_line_problems(kind, lines)
    if not problems:  # only a well-formed script can be hashed and checked against the limits
        if data["deck_sha256"] != _sha256_of(deck_path):
            problems.append("the deck changed since this script was generated (deck_sha256): generate it again")
        if data["content_sha256"] != _script_digest(lines):
            problems.append("content_sha256 does not match the lines: the file was edited after it was "
                            "generated; generate it again")
        problems += _script_limit_problems(kind, lines, spec)
    if problems:
        raise MaintenanceError(f"invalid script file {path}: " + "; ".join(problems))
    return LoadedScript(path, kind, name, lines, data["content_sha256"], data["generated_at"])


def _announce_script(loaded: LoadedScript, name: str) -> None:
    what = SCRIPT_ITEMS[loaded.kind]
    _out(f"USING_SCRIPT {loaded.kind} {name} {loaded.content_sha256} {loaded.path}")
    _say(f"{loaded.kind} {name}: rendering the reviewed script ({len(loaded.lines)} {what}, sha256 "
         f"{loaded.content_sha256[:12]}, generated {loaded.generated_at}); script generation skipped")


def _refuse_existing(out: Path) -> None:
    if out.exists():
        raise MaintenanceError(f"{out} already exists: refusing to overwrite a script (generate to a new path)")


def _write_script(out: Path, payload: dict[str, Any]) -> None:
    """Create ``out`` as UTF-8 JSON; it never replaces a file, and a failed write leaves nothing behind."""
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("x", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
    except FileExistsError:
        raise MaintenanceError(f"{out} already exists: refusing to overwrite a script") from None
    except OSError as exc:
        try:
            out.unlink(missing_ok=True)
        except OSError:
            pass
        raise MaintenanceError(f"cannot write script file {out}: {exc.strerror or type(exc).__name__}") from None


def _script_payload(kind: str, name: str, spec, lines: list[dict[str, Any]], deck_path: Path) -> dict[str, Any]:
    return {"schema_version": SCRIPT_SCHEMA_VERSION, "kind": kind, "key": name, "title": spec.title,
            **_spec_inputs(kind, spec), "deck_sha256": _sha256_of(deck_path),
            "generated_at": datetime.now(timezone.utc).isoformat(), "content_sha256": _script_digest(lines),
            SCRIPT_ITEMS[kind]: lines}


def _print_podcast_transcript(name: str, spec: PodcastSpec, lines: list[dict[str, Any]], n_slides: int,
                              digest: str) -> None:
    """Compact transcript for review: line id, slide, speaker, text; [+id@n] = listener reaction after sentence n."""
    words = sum(len(line["text"].split()) for line in lines)
    used = {line["slide_idx"] for line in lines
            if line["slide_idx"] is not None and 0 <= line["slide_idx"] < n_slides}
    _out(f"== podcast {name}: {spec.title} | {spec.language} | {spec.style} | {spec.audience_level} ==")
    for line in lines:
        slide = "-" if line["slide_idx"] is None else line["slide_idx"]
        hint = f"  [+{line['reaction']['reaction_id']}@{line['reaction']['after_sentence']}]" \
            if line["reaction"] else ""
        _out(f"{line['idx']:>2} s{slide:<2} {line['speaker']:<11} {line['text']}{hint}")
    _out(f"== {len(lines)} turns, {words} words, slides referenced {len(used)}/{n_slides}, "
         f"sha256 {digest[:12]} ==")


def _print_video_transcript(name: str, spec: VideoSpec, lines: list[dict[str, Any]], slides: list[int],
                            digest: str) -> None:
    words = sum(len(line["narration"].split()) for line in lines)
    silent = sorted(set(slides) - {line["slide_index"] for line in lines})
    _out(f"== video {name}: {spec.title} | {spec.language} | {spec.style} | {spec.audience_level} | "
         f"{spec.voice} ==")
    for line in lines:
        style = f" ({line['speaking_style']})" if line["speaking_style"] else ""
        _out(f"slide {line['slide_index']:>2}{style}: {line['narration']}")
    _out(f"== {len(lines)} narrations, {words} words, slides without narration: {silent or 'none'}, "
         f"sha256 {digest[:12]} ==")


# ---------------------------------------------------------------------------
# Podcasts
# ---------------------------------------------------------------------------
def _podcast_roles(language: str):
    from services import avatar_registry
    from services.podcast_models import RenderRoles, RoleConfig
    from services.voice_catalog import is_allowed_voice

    roles = RenderRoles(
        interviewer=RoleConfig(display_name=INTERVIEWER[0], avatar=INTERVIEWER[1],
                               voice=VOICES[language][INTERVIEWER[2]]),
        expert=RoleConfig(display_name=EXPERT[0], avatar=EXPERT[1], voice=VOICES[language][EXPERT[2]]),
    )
    for role in (roles.interviewer, roles.expert):
        if not avatar_registry.is_known(role.avatar) or avatar_registry.get(role.avatar).id != role.avatar:
            raise MaintenanceError(f"avatar {role.avatar!r} is not registered (CUSTOM_AVATARS_JSON)")
        if not is_allowed_voice(role.voice):
            raise MaintenanceError(f"voice {role.voice!r} is not allowed")
    return roles


def _existing(lib, titles: frozenset[str] | set[str], fmt: Optional[str] = None) -> Optional[dict]:
    """First library item with one of ``titles`` (and, for podcasts, the format ``fmt``).

    Items without a ``format`` (manifest v1) are videos."""
    items = [i for i in lib.list() if i.get("title") in titles
             and (fmt is None or (i.get("format") or "video") == fmt)]
    return items[0] if items else None


def _podcast_format(spec: PodcastSpec, fmt: Optional[str]) -> str:
    value = fmt or spec.format
    if value not in PODCAST_FORMATS:
        raise MaintenanceError(f"unknown podcast format {value!r} (expected one of {list(PODCAST_FORMATS)})")
    return value


async def _podcast_document(cfg, name: str, spec: PodcastSpec, path: Path):
    """Ingest the episode's deck as the render does (staged copy, slide images, display title)."""
    from services.podcast_ingest import ingest_file

    _say(f"podcast {name}: ingest {spec.deck}")
    staged = _staged_copy(path, "podcast")
    doc = await asyncio.to_thread(ingest_file, staged, cfg.libreoffice_path or "soffice")
    doc.title = spec.title
    return doc


async def _generate_podcast_turns(cfg, name: str, spec: PodcastSpec, doc) -> list:
    """The episode's script from the model, checked against the router's limits."""
    from routers import podcast as pr
    from services.podcast_models import ScriptRequest
    from services.podcast_script import generate_script_stream

    _say(f"podcast {name}: script ({spec.language}, {spec.style}, {spec.audience_level})")
    req = ScriptRequest(document_id=doc.id, language=spec.language, style=spec.style, length=spec.length,
                        num_turns=spec.num_turns, audience_level=spec.audience_level)
    turns = [t async for t in generate_script_stream(cfg, doc, req)]
    if not turns:
        raise MaintenanceError("script generation returned no turns")
    _router_limits(pr._check_turns, turns)
    return turns


async def render_podcast(cfg, name: str, *, dry_run: bool = False, deck_dir: Optional[Path] = None,
                         force: bool = False, fmt: Optional[str] = None, unpublished: bool = False,
                         from_script: Optional[Path] = None) -> dict:
    """Render + publish one ``PODCASTS`` episode; ``fmt`` overrides the spec's format.

    ``unpublished`` renders privately: the item stays archived with ``published: false`` and
    its id is printed as ``RENDERED podcast <name> <job id>``. An existing item with the title
    is then only reported (never published), unless ``force`` renders a fresh one.
    ``from_script`` renders exactly the turns of a file written by ``script_podcast`` and skips
    script generation; the file is validated before any ingest, model call or library access."""
    from routers import podcast as pr
    from services.podcast_models import JobOutputs, JobProgress, JobState, PodcastJob, Script

    spec = PODCASTS[name]
    fmt = _podcast_format(spec, fmt)
    path = _deck_path(spec.deck, deck_dir)
    loaded = _load_script(from_script, "podcast", name, spec, path) if from_script is not None else None
    roles = _podcast_roles(spec.language)
    lib = pr._get_library(cfg)
    if not lib.available:
        raise MaintenanceError("podcast library storage unavailable")
    plan = {"name": name, "title": spec.title, "format": fmt, "language": spec.language, "style": spec.style,
            "audience_level": spec.audience_level,
            "roles": {"interviewer": roles.interviewer.model_dump(), "expert": roles.expert.model_dump()}}
    if loaded:
        plan["script"] = loaded.summary()
    found = _existing(lib, spec.titles, fmt)
    if found and force:
        plan["replaces"] = found["job_id"]
    elif found:
        plan.update(action="exists", job_id=found["job_id"], published=found.get("published"))
        if not found.get("published") and not dry_run and not unpublished:
            lib.set_published(found["job_id"], True)
            plan["published"] = True
        _say(f"podcast {name}: exists ({found['job_id']})"
             + ("; add --force to render a new private item" if unpublished else ""))
        return plan
    if dry_run:
        plan["action"] = "would render"
        return plan

    if loaded:
        _announce_script(loaded, name)
    doc = await _podcast_document(cfg, name, spec, path)
    pr.DOCUMENTS[doc.id] = doc
    turns = _podcast_turns_from(loaded.lines) if loaded else await _generate_podcast_turns(cfg, name, spec, doc)
    script = Script(id=f"scr-{uuid.uuid4().hex[:8]}", document_id=doc.id, language=spec.language,
                    style=spec.style, length=spec.length, audience_level=spec.audience_level, turns=turns)
    pr.SCRIPTS[script.id] = script

    now = pr._now()
    job = PodcastJob(id=f"job-{uuid.uuid4().hex[:8]}", script_id=script.id, roles=roles,
                     layout="split_screen_with_slides", music=True, intro=True, state=JobState.queued,
                     progress=JobProgress(stage="queued", total=len(turns)), outputs=JobOutputs(),
                     created_at=now, updated_at=now, format=fmt, reactions=True)
    pr.JOBS[job.id] = job
    _say(f"podcast {name}: render {job.id} ({fmt}, {len(turns)} turns)")
    await pr._render_job_body(job.id, cfg)
    if job.state != JobState.done or job.archive_state != "published":
        raise MaintenanceError(f"podcast {job.id} failed: state={job.state.value} archive={job.archive_state}")
    if unpublished:
        # The library archives every render with published=false; nothing below may flip it.
        print(f"RENDERED podcast {name} {job.id}", flush=True)
    elif not lib.set_published(job.id, True):
        raise MaintenanceError(f"podcast {job.id} rendered but publishing failed")
    # Warnings are stable codes (podcast_media.WARNING_CODES), never raw error text.
    plan.update(action="rendered", job_id=job.id, published=not unpublished, turns=len(turns),
                warnings=list(job.warnings), listener_mode=job.listener_mode)
    suffix = f" (warnings: {', '.join(job.warnings)})" if job.warnings else ""
    _say(f"podcast {name}: {'rendered, still private' if unpublished else 'published'} {job.id}{suffix}")
    return plan


async def script_podcast(cfg, name: str, *, out: Path, dry_run: bool = False,
                         deck_dir: Optional[Path] = None) -> dict:
    """Generate one ``PODCASTS`` script for review: the render's own ingest and model call, nothing else.

    No render, no library access, nothing published. Writes the script as JSON to ``out`` (never
    replacing a file), prints the transcript and ``SCRIPTED podcast <name> <sha256> <out>``.
    ``dry_run`` makes no model call and writes nothing."""
    spec = PODCASTS[name]
    path = _deck_path(spec.deck, deck_dir)
    plan: dict[str, Any] = {"kind": "podcast", "name": name, "title": spec.title, "deck": spec.deck,
                            "language": spec.language, "style": spec.style,
                            "audience_level": spec.audience_level, "length": spec.length,
                            "num_turns": spec.num_turns, "out": str(out)}
    _refuse_existing(out)
    if dry_run:
        plan["action"] = "would generate"
        return plan
    doc = await _podcast_document(cfg, name, spec, path)
    lines = _podcast_lines(await _generate_podcast_turns(cfg, name, spec, doc))
    problems = _script_line_problems("podcast", lines)
    if problems:
        raise MaintenanceError("the generated script cannot be rendered, nothing written: " + "; ".join(problems))
    payload = _script_payload("podcast", name, spec, lines, path)
    _write_script(out, payload)
    _print_podcast_transcript(name, spec, lines, len(doc.slide_titles), payload["content_sha256"])
    _out(f"SCRIPTED podcast {name} {payload['content_sha256']} {out}")
    plan.update(action="scripted", turns=len(lines), content_sha256=payload["content_sha256"],
                generated_at=payload["generated_at"])
    _say(f"podcast {name}: script written to {out}")
    return plan


# ---------------------------------------------------------------------------
# Videos
# ---------------------------------------------------------------------------
def _check_video_voice(spec: VideoSpec) -> None:
    from services import avatar_registry
    from services.voice_catalog import is_allowed_voice

    if not is_allowed_voice(spec.voice):
        raise MaintenanceError(f"voice {spec.voice!r} is not allowed")
    # The video worker picks the presenter from the voice (gender match); make
    # sure that resolves to the requested photo avatar before spending a render.
    resolved = avatar_registry.for_voice(spec.voice).id
    if resolved != spec.avatar:
        raise MaintenanceError(f"voice {spec.voice} resolves to avatar {resolved!r}, expected {spec.avatar!r}")


async def _video_document(name: str, spec: VideoSpec, path: Path):
    """Ingest the video's deck as the render does (staged copy, slide images, display title)."""
    from services.video_ingest import ingest

    _say(f"video {name}: ingest {spec.deck}")
    staged = _staged_copy(path, "video")
    doc = await asyncio.to_thread(ingest, str(staged), spec.deck)
    doc.title = spec.title
    return doc


async def _generate_video_narrations(cfg, name: str, spec: VideoSpec, doc) -> list:
    """The video's script from the model, checked against the router's render limits."""
    from services.video_models import ScriptRequest
    from services.video_script import generate_script_stream

    _say(f"video {name}: script ({spec.language}, {spec.audience_level})")
    req = ScriptRequest(language=spec.language, style=spec.style, audience_level=spec.audience_level,
                        voice=spec.voice)
    narrations = [n async for n in generate_script_stream(cfg, doc, req)]
    if not narrations:
        raise MaintenanceError("script generation returned no narrations")
    _check_narrations(narrations)
    return narrations


async def render_video(cfg, name: str, *, dry_run: bool = False, deck_dir: Optional[Path] = None,
                       force: bool = False, unpublished: bool = False,
                       from_script: Optional[Path] = None) -> dict:
    """Render + publish one ``VIDEOS`` entry.

    ``unpublished`` renders privately: the item stays archived with ``published: false`` and
    its id is printed as ``RENDERED video <name> <job id>``. An existing item with the title
    is then only reported (never published), unless ``force`` renders a fresh one.
    ``from_script`` renders exactly the narrations of a file written by ``script_video`` and
    skips script generation; the file is validated before any ingest, model call or library access."""
    from routers import video as vr
    from services.video_models import JobOutputs, JobProgress, JobState, VideoJob, VideoScript

    spec = VIDEOS[name]
    path = _deck_path(spec.deck, deck_dir)
    _check_video_voice(spec)
    loaded = _load_script(from_script, "video", name, spec, path) if from_script is not None else None
    lib = vr._get_library(cfg)
    if not lib.available:
        raise MaintenanceError("video library storage unavailable")
    plan = {"name": name, "title": spec.title, "language": spec.language, "voice": spec.voice,
            "avatar": spec.avatar, "audience_level": spec.audience_level, "style": spec.style}
    if loaded:
        plan["script"] = loaded.summary()
    found = _existing(lib, spec.titles)
    if found and force:
        plan["replaces"] = found["job_id"]
    elif found:
        plan.update(action="exists", job_id=found["job_id"], published=found.get("published"))
        if not found.get("published") and not dry_run and not unpublished:
            lib.set_published(found["job_id"], True)
            plan["published"] = True
        _say(f"video {name}: exists ({found['job_id']})"
             + ("; add --force to render a new private item" if unpublished else ""))
        return plan
    if dry_run:
        plan["action"] = "would render"
        return plan

    if loaded:
        _announce_script(loaded, name)
    doc = await _video_document(name, spec, path)
    vr.DOCUMENTS[doc.doc_id] = doc
    narrations = (_video_narrations_from(loaded.lines, spec, doc) if loaded
                  else await _generate_video_narrations(cfg, name, spec, doc))
    vr.SCRIPTS[doc.doc_id] = VideoScript(
        doc_id=doc.doc_id, language=spec.language, style=spec.style, audience_level=spec.audience_level,
        voice=spec.voice, narrations=sorted(narrations, key=lambda n: n.slide_index),
    )

    now = vr._now()
    job = VideoJob(job_id=f"sv-{uuid.uuid4().hex[:8]}", doc_id=doc.doc_id, state=JobState.queued,
                   progress=JobProgress(stage="queued", total=len(narrations)), outputs=JobOutputs(),
                   created_at=now, updated_at=now)
    vr.JOBS[job.job_id] = job
    _say(f"video {name}: render {job.job_id} ({len(narrations)} slides)")
    await vr._render_job_body(job.job_id, cfg)
    if job.state != JobState.done or job.archive_state != "published":
        raise MaintenanceError(f"video {job.job_id} failed: state={job.state.value} archive={job.archive_state}")
    if unpublished:
        # The library archives every render with published=false; nothing below may flip it.
        print(f"RENDERED video {name} {job.job_id}", flush=True)
    elif not lib.set_published(job.job_id, True):
        raise MaintenanceError(f"video {job.job_id} rendered but publishing failed")
    plan.update(action="rendered", job_id=job.job_id, published=not unpublished, slides=len(narrations))
    _say(f"video {name}: {'rendered, still private' if unpublished else 'published'} {job.job_id}")
    return plan


async def script_video(cfg, name: str, *, out: Path, dry_run: bool = False,
                       deck_dir: Optional[Path] = None) -> dict:
    """Generate one ``VIDEOS`` script for review: the render's own ingest and model call, nothing else.

    No render, no library access, nothing published. Writes the script as JSON to ``out`` (never
    replacing a file), prints the transcript and ``SCRIPTED video <name> <sha256> <out>``.
    ``dry_run`` makes no model call and writes nothing."""
    spec = VIDEOS[name]
    path = _deck_path(spec.deck, deck_dir)
    _check_video_voice(spec)
    plan: dict[str, Any] = {"kind": "video", "name": name, "title": spec.title, "deck": spec.deck,
                            "language": spec.language, "style": spec.style,
                            "audience_level": spec.audience_level, "voice": spec.voice, "out": str(out)}
    _refuse_existing(out)
    if dry_run:
        plan["action"] = "would generate"
        return plan
    doc = await _video_document(name, spec, path)
    lines = _video_lines(await _generate_video_narrations(cfg, name, spec, doc))
    problems = _script_line_problems("video", lines)
    if problems:
        raise MaintenanceError("the generated script cannot be rendered, nothing written: " + "; ".join(problems))
    _video_narrations_from(lines, spec, doc)  # every narration must belong to a slide of this deck
    payload = _script_payload("video", name, spec, lines, path)
    _write_script(out, payload)
    _print_video_transcript(name, spec, lines, [s.index for s in doc.slides], payload["content_sha256"])
    _out(f"SCRIPTED video {name} {payload['content_sha256']} {out}")
    plan.update(action="scripted", narrations=len(lines), content_sha256=payload["content_sha256"],
                generated_at=payload["generated_at"])
    _say(f"video {name}: script written to {out}")
    return plan


# ---------------------------------------------------------------------------
# Listener kits (warm-up)
# ---------------------------------------------------------------------------
def warm_listeners(cfg, *, languages: Optional[list[str]] = None, dry_run: bool = False,
                   timeout_sec: Optional[float] = None) -> dict[str, Any]:
    """Build (or find cached) the listener kit of each podcast host in each language.

    One kit per (avatar, voice, language) of the showcase cast; a missing kit
    costs one batch avatar job. Kits never fail a render (fallback listener),
    so this only reports: ``ok`` is False when the kit fell back or has no
    backchannel clips. The output holds registry avatar ids, voices, modes
    and stable warning codes only — never Speech character names."""
    from services.podcast_media import (
        WARNING_LISTENER_FALLBACK, WARNING_LISTENER_TIMEOUT, listener_mode, listener_timeout_sec,
    )

    langs = list(dict.fromkeys(languages or VOICES))
    unknown = [lang for lang in langs if lang not in VOICES]
    if unknown:
        raise MaintenanceError(f"no podcast voices for {unknown} (known: {list(VOICES)})")
    if timeout_sec is not None and not timeout_sec > 0:
        raise MaintenanceError("--timeout must be positive")
    kits: list[tuple[str, str, str]] = []
    for lang in langs:
        roles = _podcast_roles(lang)
        kits += [(role.avatar, role.voice, lang) for role in (roles.interviewer, roles.expert)]
    budget = float(timeout_sec) if timeout_sec else listener_timeout_sec()
    report: dict[str, Any] = {"dry_run": dry_run, "listener_mode": listener_mode(), "timeout_sec": budget,
                              "kits": [], "errors": []}
    if dry_run:
        report["kits"] = [{"avatar_id": avatar, "voice": voice, "language": lang, "action": "would warm"}
                          for avatar, voice, lang in kits]
        return report

    from services import podcast_listener

    fell_back = {WARNING_LISTENER_FALLBACK, WARNING_LISTENER_TIMEOUT}
    for avatar_id, voice, lang in kits:
        label = f"listener kit {avatar_id} ({lang})"
        _say(f"{label}: warming")
        started = time.monotonic()
        try:
            kit = podcast_listener.ensure_listener_kit(cfg, avatar_id, voice, lang, want_reactions=True,
                                                       deadline=started + budget)
        except Exception as exc:  # noqa: BLE001 — documented as never raising; keep going regardless
            report["errors"].append({"item": label, "error": type(exc).__name__})
            report["kits"].append({"avatar_id": avatar_id, "voice": voice, "language": lang, "ok": False})
            _say(f"FAILED {label}: {type(exc).__name__}")
            continue
        warnings = list(kit.warnings)
        idle = kit.idle
        entry: dict[str, Any] = {
            "avatar_id": kit.avatar_id,
            "voice": kit.voice,
            "language": lang,
            "mode": kit.mode,
            "idle": None if idle is None else {"duration_sec": round(idle.duration_sec, 2),
                                                 "motion_score": round(idle.motion_score, 3),
                                                 "static": idle.static},
            "reactions": sorted(kit.reactions),
            "warnings": warnings,
            "elapsed_sec": round(time.monotonic() - started, 1),
            "ok": not (fell_back & set(warnings)) and bool(kit.reactions),
        }
        if not entry["ok"]:
            report["errors"].append({"item": label, "error": ", ".join(warnings) or "no backchannel clips"})
        suffix = f", warnings: {', '.join(warnings)}" if warnings else ""
        _say(f"{label}: {kit.mode}, {len(kit.reactions)} reactions{suffix}")
        report["kits"].append(entry)
    return report


# ---------------------------------------------------------------------------
# Publish / unpublish podcasts and videos (staged rollout)
# ---------------------------------------------------------------------------
KINDS = ("podcast", "video")


def _id_ok(kind: str, value: Any) -> bool:
    from security import PODCAST_JOB_RE, VIDEO_JOB_RE, is_valid

    return is_valid(value, PODCAST_JOB_RE if kind == "podcast" else VIDEO_JOB_RE)


def _library(cfg, kind: str):
    from routers import podcast as pr
    from routers import video as vr

    lib = (pr if kind == "podcast" else vr)._get_library(cfg)
    if not lib.available:
        raise MaintenanceError(f"{kind} library storage unavailable")
    return lib


class _FlagView:
    """The items of one library and their publish flags: read once, updated as flags are written."""

    def __init__(self, kind: str, lib):
        self.kind, self.lib = kind, lib
        self.items: dict[Any, dict] = {}
        self.state: dict[Any, bool] = {}
        self.refresh()

    def refresh(self) -> None:
        """Re-read the flags from storage (after a failed write, to report what is really live)."""
        self.items = {i.get("job_id"): i for i in self.lib.list()}
        self.state = {job_id: bool(i.get("published")) for job_id, i in self.items.items()}

    def apply(self, job_id: str, published: bool, *, dry_run: bool = False) -> str:
        """Set one flag through the library (the routers' code path).

        Returns ``already``, ``published``/``unpublished`` (``would ...`` in a dry run) or ``failed``."""
        if self.state[job_id] == published:
            return "already"
        if dry_run:
            self.state[job_id] = published
            return "would publish" if published else "would unpublish"
        try:
            ok = self.lib.set_published(job_id, published) is not None
        except Exception as exc:  # noqa: BLE001 — recorded as a failed step, never a traceback mid-switch
            log.warning("%s %s: publish flag update raised %s", self.kind, job_id, type(exc).__name__)
            ok = False
        if not ok:
            return "failed"
        self.state[job_id] = published
        return "published" if published else "unpublished"


def publish_items(cfg, *, podcast_ids: Sequence[str] = (), video_ids: Sequence[str] = (), published: bool = True,
                  dry_run: bool = False) -> dict[str, Any]:
    """Show (``published=True``) or hide podcasts and videos from anonymous visitors, by id.

    During a staged re-render the superseded items are hidden (kept for
    rollback) until they are purged. Never deletes; the output has no URLs.
    Ids are validated (and both libraries opened) before anything is written.
    Each entry warns when its title ends up with no published item, or with
    another published item (duplicate cards for visitors)."""
    wanted = {"podcast": list(dict.fromkeys(podcast_ids)), "video": list(dict.fromkeys(video_ids))}
    if not any(wanted.values()):
        raise MaintenanceError("give at least one --podcast-id or --video-id")
    for kind, ids in wanted.items():
        bad = [i for i in ids if not _id_ok(kind, i)]
        if bad:
            raise MaintenanceError(f"invalid {kind} ids: {bad}")
    views = {kind: _FlagView(kind, _library(cfg, kind)) for kind, ids in wanted.items() if ids}
    report: dict[str, Any] = {"dry_run": dry_run, "published": published, "podcasts": [], "videos": [],
                              "errors": []}
    for kind, view in views.items():
        entries = report[f"{kind}s"]
        for job_id in wanted[kind]:
            item = view.items.get(job_id)
            if item is None:
                entries.append({"job_id": job_id, "action": "not found"})
                report["errors"].append({"item": f"{kind} {job_id}", "error": "not found"})
                _say(f"{kind} {job_id}: not found")
                continue
            entry: dict[str, Any] = {"job_id": job_id, "title": item.get("title")}
            if kind == "podcast":
                entry["format"] = item.get("format") or "video"
            entry["action"] = view.apply(job_id, published, dry_run=dry_run)
            if entry["action"] == "failed":
                report["errors"].append({"item": f"{kind} {job_id}", "error": "publish flag update failed"})
            _say(f"{kind} {job_id}: {entry['action']}")
            entries.append(entry)
        for entry in entries:
            if "title" not in entry:
                continue
            entry["published"] = view.state[entry["job_id"]]
            others = sorted(j for j, i in view.items.items()
                            if j != entry["job_id"] and i.get("title") == entry["title"] and view.state[j])
            if entry["published"] and others:
                entry["warning"] = f"also published with this title: {others}"
            elif not entry["published"] and not others:
                entry["warning"] = "no published item left with this title"
    return report


def publish_podcasts(cfg, podcast_ids: list[str], *, published: bool = True,
                     dry_run: bool = False) -> dict[str, Any]:
    """``publish_items`` for podcasts only."""
    ids = list(podcast_ids)
    if not ids:
        raise MaintenanceError("give at least one --podcast-id")
    return publish_items(cfg, podcast_ids=ids, published=published, dry_run=dry_run)


# ---------------------------------------------------------------------------
# Staged switch: plan-switch / switch / rollback (visibility only, nothing is deleted)
# ---------------------------------------------------------------------------
# (step, manifest field, target flag) in run order: the item that must be visible goes
# live before the other one is hidden, so visitors never see a gap.
SWITCH_STEPS: dict[str, tuple[tuple[str, str, bool], ...]] = {
    "switch": (("publish_new", "new_id", True), ("unpublish_old", "old_id", False)),
    "rollback": (("publish_old", "old_id", True), ("unpublish_new", "new_id", False)),
}
# command -> pair status while running, when done, when a step failed
SWITCH_STATUS = {
    "switch": ("switching", "switched", "switch_failed"),
    "rollback": ("rolling_back", "rolled_back", "rollback_failed"),
}
MANIFEST_VERSION = 1


def _pair_key(kind: str, item: dict) -> tuple[str, str, str]:
    """What a re-render shares with the item it replaces: title (slug or display), format, language."""
    title = item.get("title") or ""
    fmt = (item.get("format") or "video") if kind == "podcast" else ""
    return DISPLAY_TITLES.get(title, title), fmt, item.get("language") or ""


def _created(item: dict) -> str:
    # Library timestamps are all datetime.now(timezone.utc).isoformat(), so strings sort chronologically.
    return str(item.get("created_at") or "")


def _save_manifest(path: Path, data: dict[str, Any]) -> None:
    """Rewrite the manifest atomically, so a crash never leaves a half-written record."""
    tmp = path.with_name(path.name + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as exc:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise MaintenanceError(f"cannot write manifest {path}: {exc.strerror or type(exc).__name__}") from None


def _load_manifest(path: Path) -> dict[str, Any]:
    """Read and validate a switch manifest: ``{"pairs": [{"kind", "old_id", "new_id"}, ...]}``."""
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except OSError as exc:
        raise MaintenanceError(f"cannot read manifest {path}: {exc.strerror or type(exc).__name__}") from None
    except ValueError as exc:
        raise MaintenanceError(f"manifest {path} is not valid JSON: {exc}") from None
    pairs = data.get("pairs") if isinstance(data, dict) else None
    if not isinstance(pairs, list) or not pairs:
        raise MaintenanceError('manifest must be {"pairs": [{"kind", "old_id", "new_id"}, ...]} '
                               "with at least one pair")
    problems: list[str] = []
    seen: set[str] = set()
    for n, pair in enumerate(pairs, 1):
        kind = pair.get("kind") if isinstance(pair, dict) else None
        if kind not in KINDS:
            problems.append(f"pair {n}: kind must be one of {list(KINDS)}")
            continue
        for field in ("old_id", "new_id"):
            value = pair.get(field)
            if not _id_ok(kind, value):
                problems.append(f"pair {n}: {field} {str(value)[:40]!r} is not a valid {kind} id")
            elif value in seen:
                problems.append(f"pair {n}: {value} appears more than once in the manifest")
            else:
                seen.add(value)
        if not isinstance(pair.get("log", []), list):
            problems.append(f"pair {n}: log must be a list")
    if problems:
        raise MaintenanceError("invalid manifest: " + "; ".join(problems))
    return data


def _resolve_pairs(cfg, data: dict[str, Any]) -> dict[str, _FlagView]:
    """Open the libraries the manifest uses and check every pair against them (before any write)."""
    kinds = {pair["kind"] for pair in data["pairs"]}
    views = {kind: _FlagView(kind, _library(cfg, kind)) for kind in KINDS if kind in kinds}
    problems: list[str] = []
    for n, pair in enumerate(data["pairs"], 1):
        kind, view = pair["kind"], views[pair["kind"]]
        old, new = view.items.get(pair["old_id"]), view.items.get(pair["new_id"])
        for role, job_id, item in (("old", pair["old_id"], old), ("new", pair["new_id"], new)):
            if item is None:
                problems.append(f"pair {n}: {role} {kind} {job_id} not found")
        if old is not None and new is not None and _pair_key(kind, old) != _pair_key(kind, new):
            problems.append(f"pair {n}: {pair['old_id']} and {pair['new_id']} differ in title, format or language "
                            f"{_pair_key(kind, old)} vs {_pair_key(kind, new)}")
    if problems:
        raise MaintenanceError("manifest does not match the library, nothing was changed: " + "; ".join(problems))
    return views


def _run_switch(cfg, manifest: Path, command: str, dry_run: bool) -> dict[str, Any]:
    data = _load_manifest(manifest)
    views = _resolve_pairs(cfg, data)
    pairs = data["pairs"]
    steps = SWITCH_STEPS[command]
    running, done, failed = SWITCH_STATUS[command]
    titles = [views[p["kind"]].items[p["old_id"]].get("title") for p in pairs]
    report: dict[str, Any] = {"command": command, "manifest": str(manifest), "dry_run": dry_run, "pairs": [],
                              "errors": []}
    if not dry_run:
        _save_manifest(manifest, data)  # fail before any flag changes when the record cannot be written
    stopped = False
    for n, pair in enumerate(pairs, 1):
        kind, view = pair["kind"], views[pair["kind"]]
        entry: dict[str, Any] = {"kind": kind, "old_id": pair["old_id"], "new_id": pair["new_id"],
                                 "title": titles[n - 1], "steps": []}
        report["pairs"].append(entry)
        if stopped:
            entry["status"] = "not attempted"
        else:
            for i, (step, field, target) in enumerate(steps, 1):
                job_id = pair[field]
                outcome = view.apply(job_id, target, dry_run=dry_run)
                entry["steps"].append({"step": step, "id": job_id, "outcome": outcome})
                _say(f"{command} {n}/{len(pairs)} ({kind}): {step} {job_id}: {outcome}")
                stopped = outcome == "failed"
                if not dry_run:
                    pair.setdefault("log", []).append({"at": datetime.now(timezone.utc).isoformat(),
                                                       "command": command, "step": step, "id": job_id,
                                                       "outcome": outcome})
                    pair["status"] = failed if stopped else (done if i == len(steps) else running)
                    _save_manifest(manifest, data)
                if stopped:
                    try:
                        view.refresh()  # report what is really live, not what was intended
                    except Exception:  # noqa: BLE001 — an unreadable library reports null flags
                        view.state = {}
                    report["errors"].append({"item": f"{kind} {pair['old_id']} -> {pair['new_id']}",
                                             "error": f"{step} failed"})
                    break
            if dry_run:
                changes = any(s["outcome"].startswith("would") for s in entry["steps"])
                entry["status"] = "would change" if changes else "nothing to do"
            else:
                entry["status"] = pair["status"]
        if not dry_run:
            entry["old_published"] = view.state.get(pair["old_id"])
            entry["new_published"] = view.state.get(pair["new_id"])
    if dry_run:
        _say(f"{command} (dry run): {sum(e['status'] == 'would change' for e in report['pairs'])}/{len(pairs)} "
             "pairs would change")
    else:
        _say(f"{command}: {sum(e['status'] == done for e in report['pairs'])}/{len(pairs)} pairs {done}")
    return report


def switch(cfg, manifest: Path, *, dry_run: bool = False) -> dict[str, Any]:
    """Go live with the re-renders listed in ``manifest``.

    Per pair, in order: publish the new item, then unpublish the old one (kept, never
    deleted), stopping at the first failure. The whole manifest is checked against the
    library before anything changes; the outcome and time of every step are appended to the
    pair's ``log`` in the manifest file (atomically, after each step). Idempotent: a step
    whose item is already in its target state is ``already``. ``dry_run`` writes nothing."""
    return _run_switch(cfg, manifest, "switch", dry_run)


def rollback(cfg, manifest: Path, *, dry_run: bool = False) -> dict[str, Any]:
    """Undo ``switch``: per pair, publish the old item, then unpublish the new one (kept).

    Same checks, record and idempotency as ``switch``; acts on every pair of the manifest
    (a pair that was never switched is already in the target state)."""
    return _run_switch(cfg, manifest, "rollback", dry_run)


def plan_switch(cfg, *, out: Path, dry_run: bool = False) -> dict[str, Any]:
    """Write the switch manifest: each published item with its newer unpublished re-render.

    A re-render is an unpublished item of the same kind with the same title (slug or display),
    format and language, created after the published one. Items with no re-render are listed as
    ``unmatched``; matches that cannot be decided (several published items, or several newer
    private re-renders, for one title) are left out and reported in ``errors``, never guessed.
    Refuses to overwrite ``out`` (it may hold the record of a switch)."""
    if out.exists():
        raise MaintenanceError(f"{out} already exists: refusing to overwrite a manifest "
                               "(it may hold a switch record)")
    pairs: list[dict[str, Any]] = []
    unmatched: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for kind in KINDS:
        view = _FlagView(kind, _library(cfg, kind))
        groups: dict[tuple[str, str, str], list[dict]] = {}
        for item in view.items.values():
            groups.setdefault(_pair_key(kind, item), []).append(item)
        for key in sorted(groups):
            live = [i for i in groups[key] if view.state[i["job_id"]]]
            if not live:
                continue
            label = f"{kind} {key[0]}"
            if len(live) > 1:
                errors.append({"item": label, "error": "several published items share this title, format and "
                                                       "language: unpublish the duplicates first",
                               "published": sorted(i["job_id"] for i in live)})
                continue
            old = live[0]
            newer = sorted((i for i in groups[key] if not view.state[i["job_id"]] and _created(i) > _created(old)),
                           key=_created)
            if not newer:
                unmatched.append({"kind": kind, "job_id": old["job_id"], "title": old.get("title"),
                                  "reason": "no newer unpublished re-render"})
            elif len(newer) > 1:
                errors.append({"item": label, "error": "several newer unpublished re-renders: add the right pair "
                                                       "to the manifest by hand",
                               "published": [old["job_id"]],
                               "candidates": [{"job_id": i["job_id"], "created_at": i.get("created_at")}
                                              for i in newer]})
            else:
                new = newer[0]
                pair: dict[str, Any] = {"kind": kind, "old_id": old["job_id"], "new_id": new["job_id"],
                                        "title": old.get("title")}
                if kind == "podcast":
                    pair["format"] = key[1]
                pair.update(language=old.get("language"), old_created_at=old.get("created_at"),
                            new_created_at=new.get("created_at"))
                pairs.append(pair)
    if not pairs and not errors:
        errors.append({"item": "plan", "error": "no published item has a newer unpublished re-render"})
    written = bool(pairs) and not dry_run
    if written:
        _save_manifest(out, {"version": MANIFEST_VERSION, "created_at": datetime.now(timezone.utc).isoformat(),
                             "pairs": pairs})
    _say(f"plan-switch: {len(pairs)} pair(s), {len(unmatched)} unmatched, {len(errors)} left out"
         + (f"; manifest written to {out}" if written else ""))
    return {"dry_run": dry_run, "manifest": str(out), "written": written, "pairs": pairs,
            "unmatched": unmatched, "errors": errors}


# ---------------------------------------------------------------------------
# Purge
# ---------------------------------------------------------------------------
def missing_new_content(inv: dict, allow_missing: set[str]) -> list[str]:
    """What of the new AI catalog is not yet present + published (empty = ready)."""
    missing: list[str] = []
    decks = {d["title"]: d for d in inv["decks"]}
    for spec in SEED_DECKS:
        d = decks.get(spec.title) or decks.get(spec.slug)
        if not d or not d.get("published") or (spec.live_demo and not d.get("live_demo")):
            missing.append(f"deck:{spec.title}")
    if not any(p.get("title") == PLAYLIST_TITLE and p.get("status") != "broken" for p in inv["playlists"]):
        missing.append(f"playlist:{PLAYLIST_TITLE}")
    for kind, specs, items in (("podcast", PODCASTS, inv["podcasts"]), ("video", VIDEOS, inv["videos"])):
        published = {i.get("title") for i in items if i.get("published")}
        for name, spec in specs.items():
            key = f"{kind}:{name}"
            if not (spec.titles & published) and key not in allow_missing:
                missing.append(key)
    return missing


def purge(cfg, *, deck_titles: list[str], podcast_ids: list[str], video_ids: list[str],
          record: Optional[Path], allow_missing: set[str], dry_run: bool = False) -> dict[str, Any]:
    from routers import decks as dr
    from routers import playlists as plr
    from routers import podcast as pr
    from routers import video as vr

    protected = {t for s in SEED_DECKS for t in s.titles}
    clash = sorted(set(deck_titles) & protected)
    if clash:
        raise MaintenanceError(f"refusing to delete new AI decks: {clash}")
    new_titles = {t for s in (*PODCASTS.values(), *VIDEOS.values()) for t in s.titles}

    inv = inventory(cfg)
    missing = missing_new_content(inv, allow_missing)
    if missing:
        raise MaintenanceError(f"new content not ready, nothing deleted: {missing}")

    decks = [d for d in inv["decks"] if d["title"] in set(deck_titles)]
    not_found = sorted(set(deck_titles) - {d["title"] for d in decks})
    deck_ids = {d["deck_id"] for d in decks}
    # Playlists are only touched by a deck purge; a media-only purge never deletes one.
    playlists = [p for p in inv["playlists"]
                 if p.get("status") == "broken" or any(s.get("deck_id") in deck_ids for s in p["steps"])
                 ] if deck_ids else []
    if any(p.get("title") == PLAYLIST_TITLE and p.get("status") != "broken" for p in playlists):
        raise MaintenanceError(f"{PLAYLIST_TITLE!r} references a deck slated for deletion")
    podcasts = [i for i in inv["podcasts"] if i.get("job_id") in set(podcast_ids)]
    videos = [i for i in inv["videos"] if i.get("job_id") in set(video_ids)]
    for items, doomed in ((inv["podcasts"], podcasts), (inv["videos"], videos)):
        doomed_ids = {i["job_id"] for i in doomed}
        for item in doomed:
            if item.get("title") not in new_titles:
                continue
            # A new-catalog item may only go once a published re-render with the same title remains.
            if not any(o.get("title") == item.get("title") and o.get("published")
                       and o.get("job_id") not in doomed_ids for o in items):
                raise MaintenanceError(f"refusing to delete new item {item.get('job_id')} ({item.get('title')})")
    not_found += sorted(set(podcast_ids) - {i["job_id"] for i in podcasts})
    not_found += sorted(set(video_ids) - {i["job_id"] for i in videos})

    result: dict[str, Any] = {
        "deleted_at": datetime.now(timezone.utc).isoformat(),
        "dry_run": dry_run,
        "playlists": [{"id": p["id"], "title": p.get("title"), "status": p.get("status"),
                       "steps": [s.get("deck_title") for s in p["steps"]]} for p in playlists],
        "decks": [{"deck_id": d["deck_id"], "title": d["title"], "language": d.get("language"),
                   "published": d.get("published"), "live_demo": d.get("live_demo")} for d in decks],
        "podcasts": [{"job_id": i["job_id"], "title": i.get("title"), "language": i.get("language"),
                      "speaker_names": i.get("speaker_names")} for i in podcasts],
        "videos": [{"job_id": i["job_id"], "title": i.get("title"), "language": i.get("language"),
                    "voice": i.get("voice")} for i in videos],
        "not_found": not_found,
        "errors": [],
    }
    if not dry_run:
        def _do(label: str, fn) -> None:
            try:
                fn()
                _say(f"deleted {label}")
            except Exception as exc:  # noqa: BLE001
                detail = getattr(exc, "detail", None) or str(exc)
                result["errors"].append({"item": label, "error": str(detail)[:300]})
                _say(f"FAILED {label}: {detail}")

        # Playlists first so the decks are no longer referenced (no forced delete).
        for p in playlists:
            _do(f"playlist {p['id']}", lambda p=p: plr.delete_playlist(p["id"], cfg=cfg))
        for d in decks:
            _do(f"deck {d['deck_id']} ({d['title']})", lambda d=d: dr.delete_deck(d["deck_id"], force=False, cfg=cfg))
        for i in podcasts:
            _do(f"podcast {i['job_id']}", lambda i=i: pr.delete_library_item(i["job_id"], cfg=cfg))
        for i in videos:
            _do(f"video {i['job_id']}", lambda i=i: vr.delete_library_item(i["job_id"], cfg=cfg))
    if record:
        record.parent.mkdir(parents=True, exist_ok=True)
        record.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    return result


# ---------------------------------------------------------------------------
# Retitle (filename slug -> display title)
# ---------------------------------------------------------------------------
def _deck_search(cfg):
    from routers import decks as dr

    try:
        return dr.get_deck_search(cfg, dr.get_openai_client(cfg))
    except Exception:  # noqa: BLE001
        log.exception("deck search unavailable")
        return None


def retitle(cfg, *, dry_run: bool = False) -> dict[str, Any]:
    """Give slug-titled AI decks, podcasts and videos their display titles.

    Also rewrites the denormalized ``deck_title`` of playlist steps and of the
    deck's AI Search chunks, so search hits and playlists show the same title.
    Idempotent: items already carrying a display title are reported as
    ``already`` (their search chunks are re-synced, which is a no-op merge)."""
    from routers import decks as dr
    from routers import podcast as pr
    from routers import video as vr
    from services.storage import deck_title

    store = dr._store(cfg)
    if not store or not store.cosmos_available:
        raise MaintenanceError("Cosmos DB unavailable")
    display = set(DISPLAY_TITLES.values())
    report: dict[str, Any] = {"dry_run": dry_run, "decks": [], "playlists": [], "podcasts": [], "videos": [],
                              "errors": []}

    def _fail(item: str, msg: str) -> None:
        report["errors"].append({"item": item, "error": msg[:300]})
        _say(f"FAILED {item}: {msg}")

    final_titles: dict[str, str] = {}
    search = None if dry_run else _deck_search(cfg)
    for d in store.list_decks():
        if not isinstance(d, dict) or not d.get("id"):
            continue
        current = deck_title(d)
        target = DISPLAY_TITLES.get(current)
        if target is None and current not in display:
            continue
        entry: dict[str, Any] = {"deck_id": d["id"], "before": current, "after": target or current}
        if target is None:
            entry["action"] = "already"
        elif dry_run:
            entry["action"] = "would rename"
        elif store.set_deck_title(d["id"], target) is None:
            entry["action"] = "failed"
            _fail(f"deck {d['id']}", "title update failed")
        else:
            entry["action"] = "renamed"
        if entry["action"] != "failed":
            final_titles[d["id"]] = entry["after"]
            if search is not None:
                try:
                    entry["search_chunks"] = search.set_deck_title(d["id"], entry["after"])
                except Exception as exc:  # noqa: BLE001
                    _fail(f"search {d['id']}", str(exc))
        _say(f"deck {current!r} -> {entry['after']!r}: {entry['action']}")
        report["decks"].append(entry)

    for p in store.list_playlists():
        stale = [s for s in p.get("steps") or []
                 if s.get("deck_id") in final_titles and s.get("deck_title") != final_titles[s["deck_id"]]]
        if not stale:
            continue
        entry = {"id": p.get("id"), "title": p.get("title"),
                 "steps": [{"before": s.get("deck_title"), "after": final_titles[s["deck_id"]]} for s in stale]}
        if dry_run:
            entry["action"] = "would update"
        else:
            full = store.get_playlist(p["id"])
            if not full:
                entry["action"] = "failed"
                _fail(f"playlist {p.get('id')}", "not found")
            else:
                for s in full.get("steps") or []:
                    if s.get("deck_id") in final_titles:
                        s["deck_title"] = final_titles[s["deck_id"]]
                if store.save_playlist(full):
                    entry["action"] = "updated"
                else:
                    entry["action"] = "failed"
                    _fail(f"playlist {p.get('id')}", "save failed")
        _say(f"playlist {p.get('title')!r}: {entry['action']}")
        report["playlists"].append(entry)

    for kind, lib in (("podcasts", pr._get_library(cfg)), ("videos", vr._get_library(cfg))):
        if not lib.available:
            _fail(kind, "library storage unavailable")
            continue
        for item in lib.list():
            current = item.get("title") or ""
            target = DISPLAY_TITLES.get(current)
            doc_target = DISPLAY_TITLES.get(item.get("document_title") or "")
            if target is None and doc_target is None:
                if current in display:
                    report[kind].append({"job_id": item.get("job_id"), "before": current, "after": current,
                                         "action": "already"})
                continue
            entry = {"job_id": item.get("job_id"), "before": current, "after": target or current}
            if doc_target:
                entry["document_title"] = {"before": item.get("document_title"), "after": doc_target}
            if dry_run:
                entry["action"] = "would rename"
            elif lib.set_title(item["job_id"], target or current, document_title=doc_target) is None:
                entry["action"] = "failed"
                _fail(f"{kind[:-1]} {item.get('job_id')}", "title update failed")
            else:
                entry["action"] = "renamed"
            _say(f"{kind[:-1]} {item.get('job_id')} {current!r} -> {entry['after']!r}: {entry['action']}")
            report[kind].append(entry)
    return report


# ---------------------------------------------------------------------------
# Rebrand decks in place (same deck ids)
# ---------------------------------------------------------------------------
def _slide_text(content: bytes) -> list[dict[str, str]]:
    """Title/body/notes per slide, extracted exactly like the production parser."""
    from pptx import Presentation

    from services import pptx_parser as pp

    prs = Presentation(io.BytesIO(content))
    return [{"title": pp._extract_title(s), "body": pp._extract_body(s), "notes": pp._extract_notes(s)}
            for s in prs.slides]


def _versioned(url: str, version: int) -> str:
    return url if "?" in url else f"{url}?v={version}"


def rebrand_decks(cfg, *, dry_run: bool = False, deck_dir: Optional[Path] = None,
                  only: Optional[set[str]] = None) -> dict[str, Any]:
    """Overwrite the AI decks' slide images and slide text from the regenerated .pptx.

    Each existing deck keeps its id, title, speaker notes, translated notes,
    published/live-demo flags and playlist membership; a deck is skipped
    (error) when its slide count or any speaker note differs from the new file.
    Slide PNGs are overwritten under the same blob names, ``images_version`` is
    bumped (appended as ``?v=`` to unsigned image URLs) and the AI Search chunks
    are re-indexed with the new slide text. Idempotent: a deck whose stored
    ``source_sha256`` and slide text already match is reported ``already``.
    Never deletes decks, playlists or media."""
    from routers import decks as dr
    from services.deck_search import DeckSlide
    from services.pptx_parser import _fallback_placeholders, parse_pptx
    from services.storage import deck_title

    store = dr._store(cfg)
    if not store or not store.cosmos_available:
        raise MaintenanceError("Cosmos DB unavailable")
    if not dry_run and not store.available:
        raise MaintenanceError("Blob Storage unavailable")
    by_title: dict[str, dict] = {}
    for d in store.list_decks():
        if isinstance(d, dict) and d.get("id"):
            by_title.setdefault(dr._doc_to_summary(d).title, d)

    report: dict[str, Any] = {"dry_run": dry_run, "decks": [], "errors": []}
    search = None
    for spec in SEED_DECKS:
        if only and spec.slug not in only:
            continue
        entry: dict[str, Any] = {"title": spec.title, "file": spec.file}
        report["decks"].append(entry)

        def _fail(msg: str, entry=entry, spec=spec) -> None:
            entry["action"] = "aborted"
            entry["error"] = msg
            report["errors"].append({"item": f"deck {spec.slug}", "error": msg[:300]})
            _say(f"FAILED deck {spec.title}: {msg}")

        found = by_title.get(spec.title) or by_title.get(spec.slug)
        if not found:
            _fail("deck not found (run seed first)")
            continue
        deck_id = found["id"]
        entry["deck_id"] = deck_id
        doc = store.get_presentation(deck_id)
        if not doc or doc.get("source") != "deck":
            _fail("deck document missing")
            continue
        content = _deck_path(spec.file, deck_dir).read_bytes()
        if content[:4] != b"PK\x03\x04":
            raise MaintenanceError(f"{spec.file} is not a .pptx")
        sha = hashlib.sha256(content).hexdigest()
        new = _slide_text(content)
        old = sorted((s for s in doc.get("slides") or [] if isinstance(s, dict)),
                     key=lambda s: int(s.get("index", 0)))
        if len(new) != len(old) or int(doc.get("slide_count") or len(old)) != len(new):
            _fail(f"slide count differs (stored {len(old)}, file {len(new)})")
            continue
        bad = [i for i, (o, n) in enumerate(zip(old, new)) if (o.get("notes") or "") != n["notes"]]
        if bad:
            _fail(f"speaker notes differ on slides {[i + 1 for i in bad]}")
            continue
        changed = [i for i, (o, n) in enumerate(zip(old, new))
                   if (o.get("body") or "") != n["body"] or (o.get("title") or "") != n["title"]]
        entry["text_changes"] = len(changed)
        if doc.get("source_sha256") == sha and not changed:
            entry["action"] = "already"
            _say(f"deck {spec.title}: already rebranded")
            continue
        if dry_run:
            entry["action"] = "would rebrand"
            _say(f"deck {spec.title}: would rebrand ({len(new)} slides)")
            continue

        _say(f"deck {spec.title}: render {spec.file}")
        pres = parse_pptx(content, spec.file, cfg.libreoffice_path or "soffice")
        images = dict(pres.slide_images)
        if sorted(images) != list(range(len(new))):
            _fail(f"rendered {len(images)} images for {len(new)} slides")
            continue
        placeholders = dict(_fallback_placeholders(len(new)))
        if any(images[i] == placeholders[i] for i in images):
            _fail("slide rendering fell back to placeholders (LibreOffice unavailable?)")
            continue
        if [s.notes for s in pres.slides] != [n["notes"] for n in new]:
            _fail("parser notes differ from the text extraction")
            continue

        local_dir = dr.SLIDES_DIR / deck_id
        uploaded = 0
        for idx in sorted(images):
            if not store.upload_slide_image(deck_id, idx, images[idx]):
                break
            uploaded += 1
            local_dir.mkdir(parents=True, exist_ok=True)
            (local_dir / f"{idx}.png").write_bytes(images[idx])
        entry["images"] = uploaded
        if uploaded != len(images):
            _fail(f"blob upload failed after {uploaded}/{len(images)} images")
            continue
        if doc.get("pptx_url"):
            entry["pptx"] = "replaced" if store.upload_pptx(deck_id, doc.get("filename") or spec.file,
                                                            content) else "failed"

        latest = store.get_presentation(deck_id) or doc
        version = int(latest.get("images_version") or 0) + 1
        for s in latest.get("slides") or []:
            if not isinstance(s, dict):
                continue
            i = int(s.get("index", 0))
            s["title"], s["body"] = pres.slides[i].title, pres.slides[i].body
            url = store.get_slide_image_url(deck_id, i) or f"/api/slides/{deck_id}/{i}.png"
            s["image_url"] = _versioned(url, version)
        latest["images_version"] = version
        latest["source_sha256"] = sha
        latest["rebranded_at"] = datetime.now(timezone.utc).isoformat()
        if not store.save_presentation(latest):
            _fail("Cosmos save failed (images already replaced)")
            continue
        entry.update(action="rebranded", images_version=version)

        if search is None:
            search = _deck_search(cfg) or False
        if search:
            try:
                entry["search_chunks"] = search.index_deck([
                    DeckSlide(deck_id=deck_id, deck_title=deck_title(latest), slide_index=i,
                              slide_title=s.title or f"Slide {i + 1}", body=s.body or "", notes=s.notes or "",
                              language=latest.get("language") or spec.language)
                    for i, s in enumerate(pres.slides)
                ])
            except Exception as exc:  # noqa: BLE001
                report["errors"].append({"item": f"search {deck_id}", "error": str(exc)[:300]})
                _say(f"FAILED search reindex {deck_id}: {exc}")
        _say(f"deck {spec.title}: rebranded ({uploaded} images, v{version})")
    return report


# ---------------------------------------------------------------------------
# Everything (one operator call)
# ---------------------------------------------------------------------------
async def publish_all(cfg, *, dry_run: bool = False, deck_dir: Optional[Path] = None,
                      skip: frozenset[str] | set[str] = frozenset()) -> dict[str, Any]:
    """Seed the decks, then render each podcast and video in turn.

    Renders run one at a time (batch avatar synthesis is throttled per
    resource); a failed item is reported and the next one still runs."""
    summary: dict[str, Any] = {"seed": None, "podcasts": [], "videos": [], "errors": []}
    try:
        summary["seed"] = await seed(cfg, dry_run=dry_run, deck_dir=deck_dir)
    except Exception as exc:  # noqa: BLE001
        log.exception("seed failed")
        summary["errors"].append({"item": "seed", "error": str(getattr(exc, "detail", exc))[:300]})
    for kind, names, fn in (("podcast", PODCASTS, render_podcast), ("video", VIDEOS, render_video)):
        for name in names:
            key = f"{kind}:{name}"
            if key in skip:
                summary[f"{kind}s"].append({"name": name, "action": "skipped"})
                continue
            try:
                summary[f"{kind}s"].append(await fn(cfg, name, dry_run=dry_run, deck_dir=deck_dir))
            except Exception as exc:  # noqa: BLE001
                log.exception("%s failed", key)
                summary["errors"].append({"item": key, "error": str(getattr(exc, "detail", exc))[:300]})
                _say(f"FAILED {key}: {exc}")
    return summary


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _print(obj: Any) -> None:
    _out(json.dumps(obj, indent=2, ensure_ascii=False, default=str))


class _Parser(argparse.ArgumentParser):
    """Adds the one rule argparse cannot express: publish/unpublish need a podcast or a video id."""

    def parse_args(self, args=None, namespace=None):
        ns = super().parse_args(args, namespace)
        if ns.cmd in ("publish", "unpublish") and not (ns.podcast_id or ns.video_id):
            self.error(f"{ns.cmd}: give at least one --podcast-id or --video-id")
        return ns


def build_parser() -> argparse.ArgumentParser:
    ap = _Parser(prog="python -m maintenance.content", description=__doc__,
                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--deck-dir", type=Path, default=None, help="Directory holding the .pptx decks")
    ap.add_argument("--background", type=Path, default=None, metavar="LOG",
                    help="Detach (new session) and append all output to LOG; poll it with tail")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("inventory", help="List decks, playlists, podcasts and videos (no URLs)")
    p.add_argument("--json", type=Path, default=None)

    p = sub.add_parser("seed", help="Upload/publish/translate the AI decks and create the playlist")
    p.add_argument("--dry-run", action="store_true")

    p = sub.add_parser("script-podcast",
                       help="Generate an AI podcast script for review "
                            "(no render, no library access, nothing published)")
    p.add_argument("name", choices=list(PODCASTS))
    p.add_argument("--out", type=Path, required=True,
                   help="Script file to write (never overwrites); render it later with "
                        "render-podcast NAME --from-script FILE")
    p.add_argument("--dry-run", action="store_true", help="Show the plan; no model call, nothing written")

    p = sub.add_parser("script-video",
                       help="Generate an AI video script for review (no render, no library access, nothing published)")
    p.add_argument("name", choices=list(VIDEOS))
    p.add_argument("--out", type=Path, required=True,
                   help="Script file to write (never overwrites); render it later with "
                        "render-video NAME --from-script FILE")
    p.add_argument("--dry-run", action="store_true", help="Show the plan; no model call, nothing written")

    p = sub.add_parser("render-podcast", help="Render + publish an AI podcast (--unpublished: render privately)")
    p.add_argument("name", choices=[*PODCASTS, "all"])
    p.add_argument("--format", dest="fmt", choices=PODCAST_FORMATS, default=None,
                   help="video = MP4 + radio MP3 (Watch and Listen), audio = radio MP3 only "
                        "(default: the episode's format, video)")
    p.add_argument("--force", action="store_true",
                   help="Render a new item even if one with this title exists (switch to it afterwards)")
    p.add_argument("--unpublished", action="store_true",
                   help="Render privately: never publish the new item and print 'RENDERED podcast <name> <job id>' "
                        "(an existing item with the title is only reported; go live with plan-switch/switch)")
    p.add_argument("--from-script", type=Path, default=None, metavar="FILE",
                   help="Render exactly the turns of a script-podcast file instead of generating them "
                        "(validated first; one episode, not 'all')")
    p.add_argument("--dry-run", action="store_true")

    p = sub.add_parser("render-video", help="Render + publish an AI video (--unpublished: render privately)")
    p.add_argument("name", choices=[*VIDEOS, "all"])
    p.add_argument("--force", action="store_true",
                   help="Render a new item even if one with this title exists (switch to it afterwards)")
    p.add_argument("--unpublished", action="store_true",
                   help="Render privately: never publish the new item and print 'RENDERED video <name> <job id>' "
                        "(an existing item with the title is only reported; go live with plan-switch/switch)")
    p.add_argument("--from-script", type=Path, default=None, metavar="FILE",
                   help="Render exactly the narrations of a script-video file instead of generating them "
                        "(validated first; one video, not 'all')")
    p.add_argument("--dry-run", action="store_true")

    p = sub.add_parser("warm-listeners",
                       help="Pre-build the cached podcast listener kits (idle loop + backchannels) of the cast")
    p.add_argument("--language", action="append", default=[], choices=list(VOICES),
                   help="Limit to these languages (default: every podcast language)")
    p.add_argument("--timeout", type=float, default=None, metavar="SEC",
                   help="Budget per kit in seconds (default: PODCAST_LISTENER_TIMEOUT_SEC, 900)")
    p.add_argument("--dry-run", action="store_true")

    p = sub.add_parser("publish", help="Show podcasts/videos to anonymous visitors, or hide them with --off (kept)")
    p.add_argument("--podcast-id", action="append", default=[], metavar="JOB_ID",
                   help="job-xxxxxxxx (repeatable); give at least one --podcast-id or --video-id")
    p.add_argument("--video-id", action="append", default=[], metavar="JOB_ID", help="sv-xxxxxxxx (repeatable)")
    p.add_argument("--off", action="store_true", help="Unpublish: hide the items (nothing is deleted)")
    p.add_argument("--dry-run", action="store_true")

    p = sub.add_parser("unpublish", help="Hide podcasts/videos from anonymous visitors (publish --off; kept)")
    p.add_argument("--podcast-id", action="append", default=[], metavar="JOB_ID",
                   help="job-xxxxxxxx (repeatable); give at least one --podcast-id or --video-id")
    p.add_argument("--video-id", action="append", default=[], metavar="JOB_ID", help="sv-xxxxxxxx (repeatable)")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(off=True)

    p = sub.add_parser("plan-switch",
                       help="Write the switch manifest: each published item -> its newer unpublished re-render")
    p.add_argument("--out", type=Path, required=True, help="Manifest to write (never overwrites an existing file)")
    p.add_argument("--dry-run", action="store_true", help="Print the plan, write nothing")

    p = sub.add_parser("switch", help="Per manifest pair: publish the new item, then unpublish the old one (kept)")
    p.add_argument("--manifest", type=Path, required=True,
                   help="JSON manifest {pairs: [{kind, old_id, new_id}]}; the per-step record is written back into it")
    p.add_argument("--dry-run", action="store_true", help="Show what would change, write nothing")

    p = sub.add_parser("rollback", help="Per manifest pair: publish the old item, then unpublish the new one (kept)")
    p.add_argument("--manifest", type=Path, required=True, help="The manifest given to switch (record written back)")
    p.add_argument("--dry-run", action="store_true", help="Show what would change, write nothing")

    p = sub.add_parser("purge", help="Delete retired decks/podcasts/videos (+ their playlists)")
    p.add_argument("--deck-title", action="append", default=[])
    p.add_argument("--podcast-id", action="append", default=[])
    p.add_argument("--video-id", action="append", default=[])
    p.add_argument("--record", type=Path, default=None, help="Write the deletion record (JSON) here")
    p.add_argument("--allow-missing", action="append", default=[],
                   help="New item allowed to be absent, e.g. video:practitioner")
    p.add_argument("--dry-run", action="store_true")

    p = sub.add_parser("retitle", help="Rename slug-titled AI decks/podcasts/videos to display titles")
    p.add_argument("--dry-run", action="store_true")

    p = sub.add_parser("rebrand-decks",
                       help="Re-render the AI decks' slide images/text in place (same deck ids, notes unchanged)")
    p.add_argument("--deck", action="append", default=[], choices=[s.slug for s in SEED_DECKS],
                   help="Limit to these decks (default: all AI decks)")
    p.add_argument("--dry-run", action="store_true")

    p = sub.add_parser("all", help="seed, then every podcast, then every video (continues past failures)")
    p.add_argument("--skip", action="append", default=[], help="e.g. video:practitioner")
    p.add_argument("--dry-run", action="store_true")

    p = sub.add_parser("logtail", help="Print the end of a log with URL query strings redacted")
    p.add_argument("log", type=Path)
    p.add_argument("-n", type=int, default=40)
    return ap


_QUERY_RE = None


def redact(line: str) -> str:
    """Drop URL query strings (SAS tokens) and key-like values from a log line."""
    import re

    global _QUERY_RE
    if _QUERY_RE is None:
        _QUERY_RE = re.compile(r"(https?://[^\s?'\"]+)\?[^\s'\"]*")
    line = _QUERY_RE.sub(r"\1?<redacted>", line)
    return re.sub(r"(?i)((?:sig|key|token|secret|password)=)[^\s&'\"]+", r"\1<redacted>", line)


def logtail(path: Path, n: int) -> list[str]:
    if not path.is_file():
        return [f"(no log at {path})"]
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[-max(1, n):]
    return [redact(line) for line in lines]


def _detach(log_path: Path) -> None:
    """Double-fork into a new session writing to ``log_path`` (POSIX only).

    Lets an operator start a long render through a short-lived
    ``az containerapp exec`` call and poll the log afterwards."""
    import os

    log_path.parent.mkdir(parents=True, exist_ok=True)
    pid = os.fork()
    if pid > 0:
        print(f"started in background (pid {pid}); log: {log_path}", flush=True)
        os._exit(0)
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    fd = os.open(str(log_path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.dup2(fd, 1)
    os.dup2(fd, 2)


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.cmd == "logtail":
        print("\n".join(logtail(args.log, args.n)), flush=True)
        return 0
    if args.background:
        _detach(args.background)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    for noisy in ("azure", "httpx", "openai", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    cfg = _cfg()
    try:
        if args.cmd == "inventory":
            inv = inventory(cfg)
            if args.json:
                args.json.write_text(json.dumps(inv, indent=2, ensure_ascii=False), encoding="utf-8")
            _print(inv)
        elif args.cmd == "seed":
            _print(asyncio.run(seed(cfg, dry_run=args.dry_run, deck_dir=args.deck_dir)))
        elif args.cmd == "script-podcast":
            result = asyncio.run(script_podcast(cfg, args.name, out=args.out, dry_run=args.dry_run,
                                                deck_dir=args.deck_dir))
            if args.dry_run:
                _print(result)
        elif args.cmd == "script-video":
            result = asyncio.run(script_video(cfg, args.name, out=args.out, dry_run=args.dry_run,
                                              deck_dir=args.deck_dir))
            if args.dry_run:
                _print(result)
        elif args.cmd == "render-podcast":
            if args.from_script is not None and args.name == "all":
                raise MaintenanceError("--from-script renders one reviewed script: name the episode, not 'all'")
            names = list(PODCASTS) if args.name == "all" else [args.name]
            _print([asyncio.run(render_podcast(cfg, n, dry_run=args.dry_run, deck_dir=args.deck_dir,
                                               force=args.force, fmt=args.fmt, unpublished=args.unpublished,
                                               from_script=args.from_script))
                    for n in names])
        elif args.cmd == "render-video":
            if args.from_script is not None and args.name == "all":
                raise MaintenanceError("--from-script renders one reviewed script: name the video, not 'all'")
            names = list(VIDEOS) if args.name == "all" else [args.name]
            _print([asyncio.run(render_video(cfg, n, dry_run=args.dry_run, deck_dir=args.deck_dir,
                                             force=args.force, unpublished=args.unpublished,
                                             from_script=args.from_script))
                    for n in names])
        elif args.cmd == "warm-listeners":
            result = warm_listeners(cfg, languages=args.language or None, dry_run=args.dry_run,
                                    timeout_sec=args.timeout)
            _print(result)
            if result["errors"]:
                return 1
        elif args.cmd in ("publish", "unpublish"):
            result = publish_items(cfg, podcast_ids=args.podcast_id, video_ids=args.video_id,
                                   published=not args.off, dry_run=args.dry_run)
            _print(result)
            if result["errors"]:
                return 1
        elif args.cmd == "plan-switch":
            result = plan_switch(cfg, out=args.out, dry_run=args.dry_run)
            _print(result)
            if result["errors"]:
                return 1
        elif args.cmd in ("switch", "rollback"):
            result = (switch if args.cmd == "switch" else rollback)(cfg, args.manifest, dry_run=args.dry_run)
            _print(result)
            if result["errors"]:
                return 1
        elif args.cmd == "purge":
            result = purge(cfg, deck_titles=args.deck_title, podcast_ids=args.podcast_id,
                           video_ids=args.video_id, record=args.record,
                           allow_missing=set(args.allow_missing), dry_run=args.dry_run)
            _print(result)
            if result["errors"]:
                return 1
        elif args.cmd == "retitle":
            result = retitle(cfg, dry_run=args.dry_run)
            _print(result)
            if result["errors"]:
                return 1
        elif args.cmd == "rebrand-decks":
            result = rebrand_decks(cfg, dry_run=args.dry_run, deck_dir=args.deck_dir,
                                   only=set(args.deck) or None)
            _print(result)
            if result["errors"]:
                return 1
        elif args.cmd == "all":
            summary = asyncio.run(publish_all(cfg, dry_run=args.dry_run, deck_dir=args.deck_dir,
                                              skip=set(args.skip)))
            _print(summary)
            if summary["errors"]:
                return 1
    except MaintenanceError as exc:
        _say(f"ERROR: {exc}")
        return 2
    _say("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
