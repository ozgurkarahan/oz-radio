"""Public DTO v2 (contracts v1.2 §2.2): level, source deck and captions on library items; level and slide text on decks.

* Podcast and video public items gain ``audience_level``, ``source_deck_id`` (reader only: null for every item
  today) and ``captions_vtt_url`` (a same-origin relative URL, only when captions exist).
* Decks: ``audience_level`` on summaries and details; the anonymous slide gains ``text`` (the visible body,
  whitespace-collapsed, at most 600 characters including a trailing ``…``); the anonymous ``filename`` is the deck's
  display title. The admin slide payload does not gain ``text`` and keeps its keys.
* Nothing private travels: never notes, translated notes, SAS-signed subtitles, document titles of other items.
"""
from __future__ import annotations

import copy
import json
from types import SimpleNamespace

import pytest
from azure.core.exceptions import ResourceNotFoundError

from config import load_config
from security import UUID_RE
from services import demo_protocol as dp
from services import podcast_library as pl
from services import podcast_models as pm
from services import video_library as vl

DECK = "2d7f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"
DECK_PRIV = "3e8f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"
OTHER_DECK = "4f9f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"
SECRET_NOTES = "SECRET-SPEAKER-NOTES-9f3"
SECRET_FR = "SECRET-NOTES-FR-9f3"
UPLOADED_NAME = "Q3-board-review-CONFIDENTIAL.pptx"

PUBLIC_SLIDE_KEYS = {"index", "title", "image_url", "text"}
ADMIN_SLIDE_KEYS = {"index", "title", "image_url", "body", "notes", "translated_notes"}


# ---------------------------------------------------------------------------
# Contract constants and models
# ---------------------------------------------------------------------------
def test_the_deck_id_pattern_is_the_securitys():
    assert pm._DECK_ID_RE.pattern == UUID_RE.pattern.strip("^$")
    assert dp.PUBLIC_SLIDE_TEXT_MAX_CHARS == 600


def test_the_admin_slide_payload_does_not_gain_text():
    from routers.decks import DeckDetail, PublicDeckDetail, PublicSlidePayload, SlidePayload

    assert list(SlidePayload.model_fields) == ["index", "title", "image_url", "body", "notes", "translated_notes"]
    assert set(SlidePayload.model_fields) == ADMIN_SLIDE_KEYS
    assert list(PublicSlidePayload.model_fields) == ["index", "title", "image_url", "text"]
    assert not issubclass(SlidePayload, PublicSlidePayload)  # a field added to the public slide cannot reach admins
    assert DeckDetail.model_fields["slides"].annotation == list[SlidePayload]
    assert PublicDeckDetail.model_fields["slides"].annotation == list[PublicSlidePayload]
    assert "text" not in SlidePayload.model_fields


# ---------------------------------------------------------------------------
# Slide text
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("body,expected", [
    ("Hello", "Hello"),
    ("  Hello \n\n world\t!  ", "Hello world !"),
    ("A short live demo\nBeginner level\r\nWhat a model is", "A short live demo Beginner level What a model is"),
    ("non\u00a0breaking\u2003and\u2009thin", "non breaking and thin"),
    ("", ""),
    ("   \n\t ", ""),
    (None, ""),
    (42, ""),
    (["a", "b"], ""),
    ("Un modèle produit des mots · L’IA", "Un modèle produit des mots · L’IA"),
])
def test_slide_text_is_the_body_with_collapsed_whitespace(body, expected):
    from routers.decks import _slide_text

    assert _slide_text({"body": body}) == expected
    assert _slide_text({}) == ""


def test_slide_text_is_capped_at_600_characters_including_the_ellipsis():
    from routers.decks import _slide_text

    assert _slide_text({"body": "x" * 600}) == "x" * 600                      # exactly the cap: untouched
    cut = _slide_text({"body": "x" * 601})
    assert cut == "x" * 599 + "…" and len(cut) == 600
    long_words = _slide_text({"body": " ".join(["word"] * 1000)})
    assert len(long_words) == 600 and long_words.endswith("…")
    assert _slide_text({"body": "a\n" * 700}).endswith("…")
    # Whitespace is collapsed before the cap: 700 characters of padding do not count.
    assert _slide_text({"body": "x" * 300 + " " * 700 + "y" * 100}) == "x" * 300 + " " + "y" * 100


def test_slide_text_never_reads_the_notes():
    from routers.decks import _slide_text

    slide = {"body": "visible", "notes": SECRET_NOTES, "translated_notes": {"fr-FR": SECRET_FR}, "title": "T"}
    assert _slide_text(slide) == "visible"


# ---------------------------------------------------------------------------
# Decks over the routes
# ---------------------------------------------------------------------------
class FakeDeckStore:
    cosmos_available = True
    available = False

    def __init__(self):
        self.docs = {
            DECK: {"id": DECK, "source": "deck", "filename": UPLOADED_NAME, "title": "AI in three minutes · Live demo",
                   "slide_count": 3, "language": "en-US", "published": True, "live_demo": True,
                   "audience_level": "beginner", "slides": [
                       {"index": 0, "title": "Hi", "body": "A short live demo\nBeginner   level", "notes": SECRET_NOTES,
                        "translated_notes": {"fr-FR": SECRET_FR}},
                       {"index": 1, "title": "Long", "body": "w " * 500, "notes": SECRET_NOTES},
                       {"index": 2, "title": "Empty", "body": "", "notes": SECRET_NOTES},
                   ]},
            DECK_PRIV: {"id": DECK_PRIV, "source": "deck", "filename": "Draft.pptx", "slide_count": 1,
                        "audience_level": "guru", "slides": [{"index": 0, "title": "T", "body": "B"}]},
            OTHER_DECK: {"id": OTHER_DECK, "source": "deck", "filename": "Plain-Deck.pptx", "slide_count": 1,
                         "published": True, "slides": [{"index": 0, "title": "T", "body": "B"}]},
        }

    def list_decks(self, strict=False):
        return [{k: v for k, v in d.items() if k != "slides"} for d in self.docs.values()]

    def get_presentation(self, pid, strict=False):
        return copy.deepcopy(self.docs.get(pid))


@pytest.fixture
def decks(monkeypatch):
    import routers.decks as module

    store = FakeDeckStore()
    monkeypatch.setattr(module, "_store", lambda cfg: store)
    return store


def test_public_deck_slides_carry_the_visible_text_and_never_the_notes(client, easyauth, decks):
    r = client.get(f"/api/decks/{DECK}")
    assert r.status_code == 200
    slides = r.json()["slides"]
    assert all(set(s) == PUBLIC_SLIDE_KEYS for s in slides)
    assert slides[0]["text"] == "A short live demo Beginner level"
    assert len(slides[1]["text"]) == 600 and slides[1]["text"].endswith("…")
    assert slides[2]["text"] == ""
    for secret in (SECRET_NOTES, SECRET_FR, "translated_notes", '"notes"', '"body"'):
        assert secret not in r.text


def test_public_deck_filename_is_the_display_title_never_the_uploaded_file_name(client, easyauth, decks):
    r = client.get(f"/api/decks/{DECK}")
    body = r.json()
    assert body["title"] == "AI in three minutes · Live demo"
    assert body["filename"] == body["title"]
    assert UPLOADED_NAME not in r.text and ".pptx" not in r.text
    # A deck without a stored title shows the title the list shows (the file name without its extension).
    plain = client.get(f"/api/decks/{OTHER_DECK}")
    assert plain.json()["title"] == plain.json()["filename"] == "Plain-Deck" and ".pptx" not in plain.text
    # Admins keep the real file name.
    admin = client.get(f"/api/decks/{DECK}", headers=easyauth()).json()
    assert admin["filename"] == UPLOADED_NAME and admin["title"] == "AI in three minutes · Live demo"


def test_admin_deck_slides_keep_their_keys_and_gain_no_text(client, easyauth, decks):
    admin = client.get(f"/api/decks/{DECK}", headers=easyauth()).json()
    assert all(set(s) == ADMIN_SLIDE_KEYS for s in admin["slides"])
    assert admin["slides"][0]["notes"] == SECRET_NOTES and admin["slides"][0]["translated_notes"] == {
        "fr-FR": SECRET_FR}
    assert all("text" not in s for s in admin["slides"])


def test_deck_audience_level_is_on_summaries_and_details(client, easyauth, decks):
    listed = {d["deck_id"]: d for d in client.get("/api/decks").json()}
    assert set(listed) == {DECK, OTHER_DECK}                                       # published only
    assert listed[DECK]["audience_level"] == "beginner" and listed[OTHER_DECK]["audience_level"] is None
    admin_list = {d["deck_id"]: d for d in client.get("/api/decks", headers=easyauth()).json()}
    assert admin_list[DECK_PRIV]["audience_level"] is None                          # an unknown level reads as null
    assert client.get(f"/api/decks/{DECK}").json()["audience_level"] == "beginner"
    assert client.get(f"/api/decks/{OTHER_DECK}").json()["audience_level"] is None
    assert client.get(f"/api/decks/{DECK}", headers=easyauth()).json()["audience_level"] == "beginner"
    assert client.get(f"/api/decks/{DECK_PRIV}", headers=easyauth()).json()["audience_level"] is None


# ---------------------------------------------------------------------------
# Library DTOs (pure)
# ---------------------------------------------------------------------------
def _podcast_item(**overrides) -> dict:
    item = {"job_id": "job-0000aaaa", "title": "T", "created_at": "2026-01-01", "language": "en-US",
            "format": "video", "has_video": True, "has_audio": False, "has_captions": True,
            "audience_level": "practitioner", "source_deck_id": DECK, "thumbnail_url": "https://x/t"}
    item.update(overrides)
    return item


def _video_item(**overrides) -> dict:
    item = {"job_id": "sv-0000aaaa", "title": "T", "created_at": "2026-01-01", "language": "en-US",
            "has_captions": True, "audience_level": "practitioner", "source_deck_id": DECK,
            "thumbnail_url": "https://x/t", "video_url": "https://x/v"}
    item.update(overrides)
    return item


@pytest.fixture(params=["podcast", "video"])
def dto(request):
    """(public DTO builder, item factory, captions route prefix) of a library flavour."""
    import routers.podcast as pc
    import routers.video as rv

    if request.param == "podcast":
        return SimpleNamespace(kind="podcast", build=pc._public_item, item=_podcast_item,
                               url="/api/podcast/library/job-0000aaaa/captions.vtt")
    return SimpleNamespace(kind="video", build=rv._public_item, item=_video_item,
                           url="/api/video/library/sv-0000aaaa/captions.vtt")


@pytest.mark.parametrize("value,expected", [
    ("beginner", "beginner"), ("practitioner", "practitioner"), ("expert", "expert"),
    ("guru", None), ("", None), ("Beginner", None), (None, None), (3, None), (["expert"], None),
])
def test_public_items_carry_a_known_audience_level_only(dto, value, expected):
    assert dto.build(dto.item(audience_level=value))["audience_level"] == expected
    item = dto.item()
    item.pop("audience_level")
    assert dto.build(item)["audience_level"] is None


@pytest.mark.parametrize("value,expected", [
    (DECK, DECK), (None, None), ("", None), (DECK.upper(), None), ("../../secret", None), (DECK + "\n", None),
    (DECK[:-1], None), (123, None), ({"id": DECK}, None), ("job-0000aaaa", None),
])
def test_public_items_carry_a_deck_uuid_as_source_deck_id_or_null(dto, value, expected):
    assert dto.build(dto.item(source_deck_id=value))["source_deck_id"] == expected
    item = dto.item()
    item.pop("source_deck_id")
    assert dto.build(item)["source_deck_id"] is None


def test_captions_url_is_a_same_origin_relative_url_only_when_captions_exist(dto):
    assert dto.build(dto.item())["captions_vtt_url"] == dto.url
    assert dto.url.startswith("/api/") and "://" not in dto.url
    assert dto.build(dto.item(has_captions=False))["captions_vtt_url"] is None
    item = dto.item()
    item.pop("has_captions")
    assert dto.build(item)["captions_vtt_url"] is None
    for bad in ("job-../x", "sv-0000AAAA", "", None, "../../etc", "job-0000aaaa/../x", 7):
        assert dto.build(dto.item(job_id=bad))["captions_vtt_url"] is None


def test_a_podcast_without_a_video_rendition_has_no_captions_url():
    import routers.podcast as pc

    audio_only = _podcast_item(format="audio", has_video=False, has_audio=True, has_captions=True)
    assert pc._public_item(audio_only)["captions_vtt_url"] is None
    assert pc._public_item(_podcast_item(has_video=False))["captions_vtt_url"] is None


def test_public_items_never_expose_the_signed_srt_or_other_private_fields(dto):
    leaky = dto.item(srt_url="https://x/s?sig", audio_srt_url="https://x/a?sig", scorm_url="https://x/z?sig",
                     subtitle_blob="videos/sv-0000aaaa/subtitles.srt", document_title="SECRET-DOC", voice="v")
    body = dto.build(leaky)
    assert body["srt_url"] is None and body["scorm_url"] is None
    text = json.dumps(body)
    for secret in ("subtitle_blob", "subtitles.srt", "SECRET-DOC", "sig"):
        assert secret not in text


# ---------------------------------------------------------------------------
# Libraries feed the DTO: list() and get() pass the source deck and a captions flag through
# ---------------------------------------------------------------------------
class MemBlob:
    def __init__(self):
        self.store: dict[str, bytes] = {}

    def get_container_client(self, _container):
        store = self.store
        return SimpleNamespace(list_blobs=lambda name_starts_with="": [
            SimpleNamespace(name=n) for n in sorted(store) if n.startswith(name_starts_with)])

    def get_blob_client(self, container, blob):
        store = self.store

        def download_blob():
            if blob not in store:
                raise ResourceNotFoundError("missing")
            return SimpleNamespace(readall=lambda: store[blob])

        def upload_blob(data, overwrite=False, content_settings=None):
            store[blob] = bytes(data)

        return SimpleNamespace(url=f"https://acct.blob.core.windows.net/media/{blob}", download_blob=download_blob,
                               upload_blob=upload_blob)


def _library(kind: str):
    lib = (pl.PodcastLibrary if kind == "podcast" else vl.VideoLibrary)(load_config())
    lib._initialised = True
    lib._blob = MemBlob()
    lib._sas = lambda blob, lifetime=0: f"https://sas.example/{blob}" if blob else None  # type: ignore[assignment]
    return lib


def _seed(lib, kind: str, job: str, **fields) -> None:
    prefix = f"podcast-library/{job}" if kind == "podcast" else f"videos/{job}"
    manifest = {"job_id": job, "title": f"Item {job}", "created_at": "2026-01-01T00:00:00+00:00",
                "language": "en-US", "published": True, "video_blob": f"{prefix}/video.mp4",
                "subtitle_blob": f"{prefix}/subtitles.srt", "audio_blob": f"{prefix}/audio.mp3",
                "thumbnail_blob": f"{prefix}/thumb.jpg"}
    manifest.update(fields)
    lib._blob.store[f"{prefix}/manifest.json"] = json.dumps(manifest).encode("utf-8")


@pytest.mark.parametrize("kind,job,other", [("podcast", "job-0000aaaa", "job-0000bbbb"),
                                            ("video", "sv-0000aaaa", "sv-0000bbbb")])
def test_libraries_pass_the_source_deck_and_a_captions_flag_to_the_public_dto(client, easyauth, monkeypatch, kind,
                                                                               job, other):
    import routers.podcast as pc
    import routers.video as rv

    lib = _library(kind)
    _seed(lib, kind, job, source_deck_id=DECK, audience_level="expert")
    _seed(lib, kind, other, source_deck_id="../../not-a-deck", subtitle_blob=None, created_at="2025-01-01")
    monkeypatch.setattr(pc if kind == "podcast" else rv, "_get_library", lambda cfg: lib)

    for item in lib.list(published_only=True):
        assert set(("source_deck_id", "has_captions", "audience_level")) <= set(item)
    listed = {i["job_id"]: i for i in client.get(f"/api/{kind}/library").json()}
    detail = {j: client.get(f"/api/{kind}/library/{j}").json() for j in (job, other)}
    for source in (listed, detail):
        assert source[job]["source_deck_id"] == DECK and source[job]["audience_level"] == "expert"
        assert source[job]["captions_vtt_url"] == f"/api/{kind}/library/{job}/captions.vtt"
        assert source[other]["source_deck_id"] is None and source[other]["audience_level"] is None
        assert source[other]["captions_vtt_url"] is None                         # no subtitle blob


def test_an_audio_only_podcast_has_a_transcript_not_captions(client, easyauth, monkeypatch):
    import routers.podcast as pc

    monkeypatch.setenv("PODCAST_PUBLIC_AUDIO", "true")
    lib = _library("podcast")
    prefix = "podcast-library/job-0000cccc"
    _seed(lib, "podcast", "job-0000cccc", format="audio", video_blob=None, subtitle_blob=None,
          audio_subtitle_blob=f"{prefix}/audio.srt")
    monkeypatch.setattr(pc, "_get_library", lambda cfg: lib)
    for body in (client.get("/api/podcast/library").json()[0], client.get("/api/podcast/library/job-0000cccc").json()):
        assert (body["format"], body["has_video"], body["has_audio"]) == ("audio", False, True)
        assert body["captions_vtt_url"] is None


def test_a_v1_video_manifest_without_the_new_fields_reads_as_null(client, easyauth, monkeypatch):
    import routers.video as rv

    lib = _library("video")
    prefix = "videos/sv-0000aaaa"
    v1 = {"schema_version": 1, "job_id": "sv-0000aaaa", "title": "Old", "created_at": "2025-01-01T00:00:00+00:00",
          "duration_sec": 12.5, "language": "fr-FR", "voice": "v", "slide_count": 2, "published": True,
          "video_blob": f"{prefix}/video.mp4", "audio_blob": f"{prefix}/audio.mp3",
          "subtitle_blob": f"{prefix}/subtitles.srt", "thumbnail_blob": None, "scorm_blob": None}
    lib._blob.store[f"{prefix}/manifest.json"] = json.dumps(v1).encode()
    monkeypatch.setattr(rv, "_get_library", lambda cfg: lib)
    item = client.get("/api/video/library").json()[0]
    assert item["audience_level"] is None and item["source_deck_id"] is None
    assert item["captions_vtt_url"] == "/api/video/library/sv-0000aaaa/captions.vtt"
    assert item["thumbnail_url"] is None and item["srt_url"] is None


def test_the_admin_dtos_are_unchanged(client, easyauth, monkeypatch):
    """The additions are public DTO fields: the admin cards and items keep their schemas (they already carry the
    level and every signed URL)."""
    import routers.podcast as pc
    import routers.video as rv
    from services import podcast_models as podcast_models
    from services import video_models as video_models

    for kind, job, module, models in (("podcast", "job-0000aaaa", pc, podcast_models),
                                      ("video", "sv-0000aaaa", rv, video_models)):
        lib = _library(kind)
        _seed(lib, kind, job, source_deck_id=DECK, audience_level="expert")
        monkeypatch.setattr(module, "_get_library", lambda cfg, lib=lib: lib)
        listed = client.get(f"/api/{kind}/library", headers=easyauth()).json()
        assert all(set(i) == set(models.LibrarySummary.model_fields) for i in listed)
        item = client.get(f"/api/{kind}/library/{job}", headers=easyauth()).json()
        assert set(item) == set(models.LibraryItem.model_fields)
        assert listed[0]["audience_level"] == item["audience_level"] == "expert"
        for body in (*listed, item):
            assert "source_deck_id" not in body and "captions_vtt_url" not in body


def test_publishing_does_not_write_a_source_deck_yet(tmp_path):
    """The reader is in; there is no writer: ``source_deck_id`` stays null for every item (the title match of the
    recording map covers the current items). The podcast manifest keys are pinned by ``test_podcast_library_v2``."""
    lib = _library("video")
    files = vl.VideoLibraryFiles(mp4=tmp_path / "a.mp4", mp3=tmp_path / "a.mp3", srt=tmp_path / "a.srt")
    for path in (files.mp4, files.mp3, files.srt):
        path.write_bytes(b"x")
    manifest = lib.publish("sv-0000aaaa", files, title="t", document_title="d", language="en-US", voice="v",
                           slide_count=1, duration_sec=1.0, created_at="2026-01-01")
    assert manifest is not None and "source_deck_id" not in manifest
    assert "source_deck_id" not in json.loads(lib._blob.store["videos/sv-0000aaaa/manifest.json"])
    assert lib.get("sv-0000aaaa")["has_captions"] is True and lib.get("sv-0000aaaa")["subtitle_blob"] == (
        "videos/sv-0000aaaa/subtitles.srt")
