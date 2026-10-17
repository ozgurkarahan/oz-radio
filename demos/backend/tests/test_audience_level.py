"""Audience level option for podcast + video script generation."""
from __future__ import annotations

import hashlib
import json
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from services.podcast_models import Document, ScriptRequest as PodcastScriptRequest, Section
from services.video_models import ScriptRequest as VideoScriptRequest, SlideRef, VideoDocument

LEVELS = ["beginner", "practitioner", "expert"]
VOICE = "en-US-Ava:DragonHDLatestNeural"
VIDEO_DOC_ID = "0b5f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"

# SHA-256 of the system prompts for the fixtures below with audience_level=None,
# which must stay byte-for-byte. PODCAST_BASELINE_SHA was re-pinned deliberately
# when the radio-safe directive and the optional listener `reaction` hint were
# added to the podcast prompt (video prompt unchanged).
PODCAST_BASELINE_SHA = "0aa1d245da430d4962016021b3c01ede253d364527c8df8b5f7bf42f9be4ab50"
VIDEO_BASELINE_SHA = "972809be83f98e7ae23534bdfdb18a9ed970972eee27dfd6225a76270c00be4d"

LEVEL_MARKERS = {
    "beginner": ["no prior AI or technical knowledge", "plain words", "everyday analogies",
                 "acronym", "one idea at a time"],
    "practitioner": ["build or operate", "how-to", "trade-offs", "pitfalls"],
    "expert": ["architecture", "internals", "failure modes", "evaluation",
               "strictly within the source material", "do NOT invent numbers"],
}


def _podcast_doc() -> Document:
    return Document(id="doc-1", title="T", source_kind="pptx", slide_titles=["Intro", "Next"],
                    slide_notes=["n", ""], sections=[Section(text="x")])


def _video_doc() -> VideoDocument:
    return VideoDocument(doc_id="x", title="T", source_kind="pdf",
                         slides=[SlideRef(index=0, image_ref="a", title="Intro"), SlideRef(index=1, image_ref="b")])


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Model validation
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("level", LEVELS + [None])
def test_models_accept_known_levels_and_none(level):
    from services.podcast_models import Script
    from services.video_models import VideoScript

    assert PodcastScriptRequest(document_id="d", audience_level=level).audience_level == level
    assert VideoScriptRequest(voice=VOICE, audience_level=level).audience_level == level
    assert Script(id="s", document_id="d", audience_level=level, turns=[]).audience_level == level
    assert VideoScript(doc_id="d", voice=VOICE, audience_level=level).audience_level == level


def test_models_default_to_none():
    assert PodcastScriptRequest(document_id="d").audience_level is None
    assert VideoScriptRequest(voice=VOICE).audience_level is None


@pytest.mark.parametrize("bad", ["guru", "Beginner", "", 3])
def test_models_reject_unknown_levels(bad):
    with pytest.raises(ValidationError):
        PodcastScriptRequest(document_id="d", audience_level=bad)
    with pytest.raises(ValidationError):
        VideoScriptRequest(voice=VOICE, audience_level=bad)


def test_endpoints_reject_unknown_level_with_422(client):
    r = client.post("/api/podcast/script/stream", json={"document_id": "d", "audience_level": "guru"})
    assert r.status_code == 422
    r = client.post(f"/api/video/script/{VIDEO_DOC_ID}", json={"voice": VOICE, "audience_level": "guru"})
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# Prompt directives
# ---------------------------------------------------------------------------
def test_podcast_prompt_unchanged_when_none():
    from services.podcast_script import _build_system_prompt

    prompt = _build_system_prompt(PodcastScriptRequest(document_id="doc-1", focus="cost"), _podcast_doc())
    assert _sha(prompt) == PODCAST_BASELINE_SHA
    assert "Audience:" not in prompt


def test_video_prompt_unchanged_when_none():
    from services.video_script import _build_system_prompt

    prompt = _build_system_prompt(VideoScriptRequest(voice=VOICE, focus="cost"), _video_doc())
    assert _sha(prompt) == VIDEO_BASELINE_SHA
    assert "Audience:" not in prompt


@pytest.mark.parametrize("level", LEVELS)
def test_podcast_prompt_contains_level_directive(level):
    from services.podcast_script import _audience_line, _build_system_prompt

    doc = _podcast_doc()
    base = _build_system_prompt(PodcastScriptRequest(document_id="doc-1", style="formal", focus="cost"), doc)
    prompt = _build_system_prompt(
        PodcastScriptRequest(document_id="doc-1", style="formal", focus="cost", audience_level=level), doc)
    for marker in LEVEL_MARKERS[level]:
        assert marker in prompt
    others = [m for lv, ms in LEVEL_MARKERS.items() if lv != level for m in ms[:1]]
    assert not any(m in prompt for m in others)
    # Composes with style/focus/language and only adds the audience line:
    # slide assignment + output format rules are untouched.
    assert "Polished, measured tone" in prompt and "Conversation angle: cost" in prompt
    assert prompt.replace(_audience_line(level), "") == base


@pytest.mark.parametrize("level", LEVELS)
def test_video_prompt_contains_level_directive(level):
    from services.video_script import _audience_line, _build_system_prompt

    doc = _video_doc()
    base = _build_system_prompt(VideoScriptRequest(voice=VOICE, language="fr-FR", focus="cost"), doc)
    prompt = _build_system_prompt(
        VideoScriptRequest(voice=VOICE, language="fr-FR", focus="cost", audience_level=level), doc)
    for marker in LEVEL_MARKERS[level]:
        assert marker in prompt
    assert "French" in prompt and "Angle / focus to emphasize: cost" in prompt
    assert "EXACTLY 2 objects" in prompt
    assert prompt.replace(_audience_line(level), "") == base


# ---------------------------------------------------------------------------
# Script generation persists the level on the saved script
# ---------------------------------------------------------------------------
def test_podcast_stream_saves_audience_level(client, monkeypatch):
    import routers.podcast as pc
    import services.podcast_script as ps
    from services.podcast_models import DialogueTurn

    seen = {}

    async def fake_stream(cfg, doc, req):
        seen["level"] = req.audience_level
        yield DialogueTurn(idx=0, speaker="interviewer", text="Hi")

    monkeypatch.setattr(ps, "generate_script_stream", fake_stream)
    monkeypatch.setitem(pc.DOCUMENTS, "doc-aud1", _podcast_doc().model_copy(update={"id": "doc-aud1"}))
    r = client.post("/api/podcast/script/stream", json={"document_id": "doc-aud1", "audience_level": "beginner"})
    assert r.status_code == 200 and "event: done" in r.text
    script_id = json.loads(r.text.split("event: done\ndata: ")[1].split("\n")[0])["script_id"]
    try:
        assert seen["level"] == "beginner"
        assert pc.SCRIPTS[script_id].audience_level == "beginner"
        assert client.get(f"/api/podcast/scripts/{script_id}").json()["audience_level"] == "beginner"
    finally:
        pc.SCRIPTS.pop(script_id, None)


def test_video_stream_saves_audience_level(client, monkeypatch):
    import routers.video as rv
    import services.video_script as vs
    from services.video_models import SlideNarration

    async def fake_stream(cfg, doc, req):
        yield SlideNarration(slide_index=0, slide_image_ref="a", narration="Hello", voice=req.voice)

    monkeypatch.setattr(vs, "generate_script_stream", fake_stream)
    monkeypatch.setitem(rv.DOCUMENTS, VIDEO_DOC_ID, _video_doc().model_copy(update={"doc_id": VIDEO_DOC_ID}))
    try:
        r = client.post(f"/api/video/script/{VIDEO_DOC_ID}", json={"voice": VOICE, "audience_level": "expert"})
        assert r.status_code == 200
        done = json.loads(r.text.strip().splitlines()[-1])
        assert done["event"] == "done" and done["data"]["audience_level"] == "expert"
        assert rv.SCRIPTS[VIDEO_DOC_ID].audience_level == "expert"
    finally:
        rv.SCRIPTS.pop(VIDEO_DOC_ID, None)


# ---------------------------------------------------------------------------
# Library round-trip (manifest -> list/get -> API)
# ---------------------------------------------------------------------------
class _FakeContainer:
    def __init__(self, store: dict):
        self.store = store

    def list_blobs(self, name_starts_with: str = ""):
        return [SimpleNamespace(name=n) for n in self.store if n.startswith(name_starts_with)]


def _wire_fake_blob(lib, store: dict) -> None:
    lib._initialised = True
    lib._blob = SimpleNamespace(get_container_client=lambda _c: _FakeContainer(store))
    lib._upload = lambda name, data, content_type: store.__setitem__(name, data)  # type: ignore[assignment]
    lib._read_json_blob = lambda name: json.loads(store[name]) if name in store else None  # type: ignore[assignment]
    lib._sas = lambda blob, minutes=24 * 60: f"sas:{blob}" if blob else None  # type: ignore[assignment]


@pytest.mark.parametrize("kind", ["podcast", "video"])
@pytest.mark.parametrize("level", ["practitioner", None])
def test_library_round_trip(kind, level, tmp_path):
    from config import load_config

    files = {}
    for ext in ("mp4", "mp3", "srt"):
        files[ext] = tmp_path / f"f.{ext}"
        files[ext].write_bytes(b"x")
    store: dict = {}
    if kind == "podcast":
        from services.podcast_library import LibraryFiles, PodcastLibrary

        lib, job = PodcastLibrary(load_config()), "job-0123abcd"
        _wire_fake_blob(lib, store)
        manifest = lib.publish(job, LibraryFiles(**files), title="t", document_title="d", language="en-US",
                               style="casual", speaker_names=["A", "B"], turn_count=2, created_at="2026-01-01",
                               audience_level=level)
    else:
        from services.video_library import VideoLibrary, VideoLibraryFiles

        lib, job = VideoLibrary(load_config()), "sv-0123abcd"
        _wire_fake_blob(lib, store)
        manifest = lib.publish(job, VideoLibraryFiles(**files), title="t", document_title="d", language="en-US",
                               voice=VOICE, slide_count=2, duration_sec=1.0, created_at="2026-01-01",
                               audience_level=level)
    assert manifest and manifest["audience_level"] == level
    assert [i["audience_level"] for i in lib.list()] == [level]
    assert lib.get(job)["audience_level"] == level
    assert lib.set_published(job, True)["audience_level"] == level


def test_library_ignores_unknown_stored_level():
    from config import load_config
    from services.podcast_library import PodcastLibrary

    lib = PodcastLibrary(load_config())
    store = {"podcast-library/job-0123abcd/manifest.json": json.dumps(
        {"job_id": "job-0123abcd", "title": "t", "audience_level": "guru"})}
    _wire_fake_blob(lib, store)
    assert lib.list()[0]["audience_level"] is None
    assert lib.get("job-0123abcd")["audience_level"] is None


class _Lib:
    available = True

    def __init__(self, job: str, url_key: str):
        self.item = {"job_id": job, "title": "T", "created_at": "2026-01-01", "language": "en-US",
                     "published": True, "audience_level": "expert"}
        self.url_key = url_key

    def list(self, *, published_only: bool = False):
        return [dict(self.item)]

    def get(self, job_id, *, public: bool = False):
        return {**self.item, self.url_key: "https://blob/v?sas"} if job_id == self.item["job_id"] else None


@pytest.mark.parametrize("kind,job,url_key", [("podcast", "job-0000aaaa", "mp4_url"),
                                               ("video", "sv-0000aaaa", "video_url")])
def test_library_api_exposes_level_to_admins_only(client, easyauth, monkeypatch, kind, job, url_key):
    import routers.podcast as pc
    import routers.video as rv

    module = pc if kind == "podcast" else rv
    monkeypatch.setattr(module, "_get_library", lambda cfg: _Lib(job, url_key))
    admin_list = client.get(f"/api/{kind}/library", headers=easyauth()).json()
    assert admin_list[0]["audience_level"] == "expert"
    assert client.get(f"/api/{kind}/library/{job}", headers=easyauth()).json()["audience_level"] == "expert"
    # Anonymous public DTO keeps its fixed shape.
    assert "audience_level" not in client.get(f"/api/{kind}/library").json()[0]
